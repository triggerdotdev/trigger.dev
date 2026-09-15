import { describe, expect, it } from "vitest";
import { createCoalescedReload } from "./coalesced-reload";

/** A run whose completion the test controls, recording the order it was started in. */
function controllable() {
  const gates: Array<() => void> = [];
  let started = 0;
  const run = () => {
    started++;
    return new Promise<void>((resolve) => gates.push(resolve));
  };
  return {
    run,
    get started() {
      return started;
    },
    finish(index: number) {
      gates[index]!();
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createCoalescedReload", () => {
  it("does not resolve a mid-flight request with data the first run already fetched", async () => {
    const c = controllable();
    const reload = createCoalescedReload(c.run);

    reload();
    let late = false;
    const lateRequest = reload().then(() => {
      late = true;
    });

    c.finish(0);
    await settle();
    // The first run is done, but it started before the late request was made.
    expect(late).toBe(false);
    expect(c.started).toBe(2);

    c.finish(1);
    await settle();
    await lateRequest;
    expect(late).toBe(true);
  });

  it("queues at most one follow-up however many requests pile up", async () => {
    const c = controllable();
    const reload = createCoalescedReload(c.run);

    reload();
    const later = [reload(), reload(), reload()];

    c.finish(0);
    await settle();
    expect(c.started).toBe(2);

    c.finish(1);
    await settle();
    await Promise.all(later);
    expect(c.started).toBe(2);
  });

  it("still serves the queued request when the run in front of it fails", async () => {
    let started = 0;
    const reload = createCoalescedReload(async () => {
      started++;
      if (started === 1) throw new Error("history request failed");
    });

    const first = reload().catch(() => {});
    const second = reload();

    await first;
    await second;
    expect(started).toBe(2);
  });

  it("joins the queued run when a request lands as the run in front of it settles", async () => {
    const c = controllable();
    const reload = createCoalescedReload(c.run);

    const first = reload();
    // Runs in the window between the first run settling and the queued one starting.
    void first.then(() => {
      void reload();
    });
    void reload();

    c.finish(0);
    await settle();
    expect(c.started).toBe(2);
  });

  it("starts a fresh run once nothing is in flight", async () => {
    const c = controllable();
    const reload = createCoalescedReload(c.run);

    const first = reload();
    c.finish(0);
    await first;

    reload();
    expect(c.started).toBe(2);
  });
});
