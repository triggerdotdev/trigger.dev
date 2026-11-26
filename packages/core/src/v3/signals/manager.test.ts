import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../apiClient/errors.js";
import type { ApiClient } from "../apiClient/index.js";
import { TestSignalsManager } from "../test/test-signals-manager.js";
import { StandardSignalsManager } from "./manager.js";
import type { Signal } from "./types.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const entry = (name: string, payload: unknown, seq: number) => ({
  name,
  payload,
  sentAt: new Date(0).toISOString(),
  seq,
});

function collect(manager: TestSignalsManager, name: string) {
  const got: Array<Pick<Signal, "payload" | "seq" | "task">> = [];
  const stop = manager.on(name, (signal) =>
    got.push({ payload: signal.payload, seq: signal.seq, task: signal.task })
  );
  return { got, stop };
}

describe("StandardSignalsManager", () => {
  // Catches: a run that starts listening after a send never learning the state (latest-on-listen).
  it("gives a late listener the latest signal of its name, then new ones in order", async () => {
    const manager = new TestSignalsManager(() => "my-task");
    manager.__sendFromTest("demo.ping", { n: 1 });
    manager.__sendFromTest("demo.ping", { n: 2 });
    manager.__sendFromTest("other", { x: 1 });

    const { got } = collect(manager, "demo.ping");
    await tick();
    expect(got.map((s) => s.payload)).toEqual([{ n: 2 }]);

    manager.__sendFromTest("demo.ping", { n: 3 });
    manager.__sendFromTest("demo.ping", { n: 4 });
    expect(got.map((s) => s.payload)).toEqual([{ n: 2 }, { n: 3 }, { n: 4 }]);
  });

  // Catches: a signal sent to another task reaching this run, or one sent to this task missing it.
  it("delivers task-targeted signals only to runs of that task", async () => {
    const manager = new TestSignalsManager(() => "my-task");
    const { got } = collect(manager, "demo.ping");
    await tick();

    manager.__sendFromTest("demo.ping", { n: 1 }, { task: "other" });
    manager.__sendFromTest("demo.ping", { n: 2 }, { task: "my-task" });
    expect(got).toEqual([{ payload: { n: 2 }, seq: 1, task: "my-task" }]);
  });

  // Catches: an async handler's rejection failing the run, and a handler that stops listening
  // still getting the next entry of the same delivery.
  it("contains async handler rejections and stops delivering once a handler stops", async () => {
    const manager = new TestSignalsManager(() => "my-task");
    manager.__sendFromTest("demo.ping", { n: 1 });
    manager.__sendFromTest("demo.ping", { n: 2 }, { task: "my-task" });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const got: unknown[] = [];
    const stop = manager.on("demo.ping", async (signal) => {
      got.push(signal.payload);
      stop();
      throw new Error("handler failed");
    });
    await tick();
    await tick();
    process.off("unhandledRejection", onUnhandled);
    expect(got).toEqual([{ n: 1 }]);
    expect(unhandled).toEqual([]);
  });

  // Catches: a reconnect (which re-reads a record carrying the same latest map) delivering a
  // signal twice, or an older value after a newer one.
  it("never repeats a signal when the latest map arrives again", async () => {
    const manager = new TestSignalsManager(() => undefined);
    const { got } = collect(manager, "a");
    await tick();
    const a = (n: number, seq: number) => entry("a", { n }, seq);

    manager.applyRecord({ name: "a", latest: [a(1, 5)] }, 5);
    manager.applyRecord({ name: "a", latest: [a(1, 5)] }, 6);
    // After a gap: only the newest of the name, never the skipped value.
    manager.applyRecord({ name: "a", latest: [a(3, 9)] }, 9);
    expect(got.map((s) => s.payload)).toEqual([{ n: 1 }, { n: 3 }]);
  });

  // Catches: a cleared signal reaching a listener that starts after the clear, in a run that was
  // already subscribed (the cache kept every name it had seen).
  it("doesn't give a later listener a signal cleared since", async () => {
    const manager = new TestSignalsManager(() => undefined);
    const keepalive = collect(manager, "keepalive");
    manager.applyRecord({ name: "a", latest: [entry("a", true, 0)] }, 0);
    manager.applyRecord({ name: "a", latest: [] }, 2);

    const { got } = collect(manager, "a");
    await tick();
    keepalive.stop();
    expect(got).toEqual([]);
  });

  // Catches: listening again after the last listener stopped delivering the value cached then,
  // before the current one (a crawl paused on a stale `true`).
  it("starts from the current state when listening again after every listener stopped", async () => {
    const manager = new TestSignalsManager(() => undefined);
    const first = collect(manager, "a");
    manager.applyRecord({ name: "a", latest: [entry("a", true, 0)] }, 0);
    await tick();
    first.stop();

    const { got } = collect(manager, "a");
    await tick();
    manager.applyRecord({ name: "a", latest: [entry("a", false, 2)] }, 2);
    expect(got.map((s) => s.payload)).toEqual([false]);
  });

  // Catches: an entry appended to the stream directly with a huge seq silencing its name, since
  // every real send then looked older.
  it("ignores an entry claiming a later seq than its record", async () => {
    const manager = new TestSignalsManager(() => undefined);
    const { got } = collect(manager, "a");
    manager.applyRecord({ name: "a", latest: [entry("a", "forged", 1_000_000)] }, 3);
    manager.applyRecord({ name: "a", latest: [entry("a", "real", 5)] }, 5);
    expect(got.map((s) => s.payload)).toEqual(["real"]);
  });

  // Catches: a recreated stream (seqs start again) being ignored until its seqs pass the old ones.
  it("delivers from a recreated stream", async () => {
    const manager = new TestSignalsManager(() => undefined);
    const { got } = collect(manager, "a");
    manager.applyRecord({ name: "a", latest: [entry("a", "old", 100)] }, 100);
    manager.applyRecord({ name: "a", latest: [entry("a", "new", 0)] }, 0);
    manager.applyRecord({ name: "a", latest: [entry("a", "newer", 2)] }, 2);
    expect(got.map((s) => s.payload)).toEqual(["old", "new", "newer"]);
  });

  // Catches: a basin move delivering the latest signal again to every live listener: the move
  // carries the latest map to the new stream under new, higher seqs.
  it("doesn't repeat a signal carried to a new stream under a new seq", async () => {
    const manager = new TestSignalsManager(() => undefined);
    const { got } = collect(manager, "a");
    const sent = (payload: unknown, seq: number, at: number) => ({
      ...entry("a", payload, seq),
      sentAt: new Date(at).toISOString(),
    });
    manager.applyRecord({ name: "a", latest: [sent("x", 502, 1)] }, 502);
    manager.applyRecord({ name: "a", latest: [sent("x", 504, 1)] }, 504);
    // A move with the lift cut short: seqs start lower on the new stream.
    manager.applyRecord({ name: "a", latest: [sent("x", 10, 1)] }, 10);
    manager.applyRecord({ name: "a", latest: [sent("x", 12, 2)] }, 12);
    expect(got.map((s) => [s.payload, s.seq])).toEqual([
      ["x", 502],
      ["x", 12],
    ]);
  });

  // Catches: two sends of the same name in the same millisecond with the same payload reaching a
  // listener as one.
  it("delivers distinct sends with the same time and payload", async () => {
    const manager = new TestSignalsManager(() => undefined);
    const { got } = collect(manager, "a");
    manager.applyRecord({ name: "a", latest: [{ ...entry("a", "ping", 1), id: "s1" }] }, 1);
    manager.applyRecord({ name: "a", latest: [{ ...entry("a", "ping", 3), id: "s2" }] }, 3);
    // A move carrying s2 over under a new seq.
    manager.applyRecord({ name: "a", latest: [{ ...entry("a", "ping", 9), id: "s2" }] }, 9);
    expect(got.map((s) => s.seq)).toEqual([1, 3]);
  });

  // Catches: a move carrying in an older task-scoped send under the newer one sent to every run,
  // and the live listener ending on (or flapping through) the older value.
  it("doesn't apply an older scope a move carries in under a newer one", async () => {
    const manager = new TestSignalsManager(() => "crawler");
    const { got } = collect(manager, "paused");
    const everyone = { ...entry("paused", false, 3), id: "everyone" };
    const scoped = { ...entry("paused", true, 0), task: "crawler", id: "scoped" };
    manager.applyRecord({ name: "paused", latest: [everyone] }, 3);
    manager.applyRecord(
      {
        name: "paused",
        latest: [
          { ...scoped, seq: 10 },
          { ...everyone, seq: 11 },
        ],
      },
      11
    );
    expect(got.map((s) => s.payload)).toEqual([false]);

    // A listener that starts now gets both, in order, and ends on the same value.
    const late = collect(manager, "paused");
    await tick();
    expect(late.got.map((s) => s.payload)).toEqual([true, false]);
  });

  // Catches: a handler changing the payload it was given (a bigint) making a later listener throw
  // before its handler ran.
  it("gives a later listener a signal whose payload an earlier handler changed", async () => {
    const manager = new TestSignalsManager(() => undefined);
    manager.on("a", (signal) => {
      (signal.payload as { cents?: bigint }).cents = 1n;
    });
    manager.applyRecord({ name: "a", latest: [entry("a", { amount: 1 }, 1)] }, 1);
    await tick();
    const { got } = collect(manager, "a");
    await tick();
    expect(got).toHaveLength(1);
  });

  // Catches: a stopped listener still being called.
  it("stops delivering after the stop function is called", async () => {
    const manager = new TestSignalsManager(() => undefined);
    const { got, stop } = collect(manager, "a");
    await tick();
    stop();
    manager.__sendFromTest("a", 1);
    expect(got).toEqual([]);
  });
});

describe("StandardSignalsManager subscription", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function subscribeCalls(status: number) {
    vi.useFakeTimers();
    const subscribeToEnvironmentSignals = vi.fn(async () => {
      throw ApiError.generate(status, {}, "Could not subscribe to stream", {});
    });
    const manager = new StandardSignalsManager(
      { subscribeToEnvironmentSignals } as unknown as ApiClient,
      "http://localhost",
      () => undefined
    );
    const stop = manager.on("a", () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    stop();
    return subscribeToEnvironmentSignals.mock.calls.length;
  }

  // Catches: a run on a server without signals (501) retrying the subscription for its whole life.
  it("stops on a status that won't change for this run", async () => {
    expect(await subscribeCalls(501)).toBe(1);
    expect(await subscribeCalls(404)).toBe(1);
    // Catches: a credential without signals access reconnecting every 30 s for the whole turn.
    expect(await subscribeCalls(403)).toBe(1);
  });

  it("keeps reconnecting after a server error", async () => {
    expect(await subscribeCalls(500)).toBeGreaterThan(1);
  });
});
