import { taskContext } from "@trigger.dev/core/v3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configure } from "../src/v3/auth.js";
import { unstable_signals } from "../src/v3/signals.js";

let urls: URL[] = [];

function respondWith(body: unknown) {
  urls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      urls.push(new URL(String(input)));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
}

const query = () => Object.fromEntries(urls[0]!.searchParams);

describe("unstable_signals.latest", () => {
  beforeEach(() => configure({ baseURL: "http://localhost:3030", accessToken: "tr_dev_test" }));
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Catches: latest() inside a run reading only the untasked entry while on() would deliver a
  // newer one sent to the run's own task first.
  it("inside a run, asks for the run's task with the untasked one included", async () => {
    vi.spyOn(taskContext, "ctx", "get").mockReturnValue({ task: { id: "my-task" } } as any);
    respondWith({ signal: null });
    expect(await unstable_signals.latest("mode")).toBeUndefined();
    expect(urls[0]!.pathname).toBe("/api/v1/signals/latest");
    expect(query()).toEqual({ name: "mode", task: "my-task", includeUntasked: "true" });

    respondWith({ signal: null });
    await unstable_signals.latest("mode", { task: "other" });
    expect(query()).toEqual({ name: "mode", task: "other" });
  });

  it("outside a run, asks for exactly (name, task) and maps sentAt to a Date", async () => {
    const sentAt = "2026-11-25T10:00:00.000Z";
    respondWith({ signal: { name: "mode", payload: { on: true }, sentAt, seq: 7 } });
    const signal = await unstable_signals.latest<{ on: boolean }>("mode");
    expect(query()).toEqual({ name: "mode" });
    expect(signal).toEqual({
      name: "mode",
      payload: { on: true },
      sentAt: new Date(sentAt),
      seq: 7,
    });
  });
});
