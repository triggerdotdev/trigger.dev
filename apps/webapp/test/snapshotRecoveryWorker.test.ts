import { PENDING_PARTITION_COUNT } from "@internal/run-store";
import { Registry } from "prom-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real module eagerly builds the run store (Prisma + Redis). Every test injects its own runtime.
vi.mock("~/v3/runStore.server", () => ({ snapshotStoreRuntime: undefined }));

import { signalsEmitter } from "~/services/signals.server";
import { initSnapshotRecoveryWorker } from "~/v3/snapshotRecoveryWorker.server";

// Captured before fake timers: a real macrotask runs only after the all-microtask fake sweep settles.
const realSetImmediate = globalThis.setImmediate;
const settleMicrotasks = () => new Promise<void>((resolve) => realSetImmediate(resolve));

function fakeRuntime() {
  const store = {
    acquireOrRenewRecoveryLease: vi.fn(async (_owner: string, _ttlMs: number) => true),
    releaseRecoveryLease: vi.fn(async (_owner: string) => {}),
  };
  const worker = {
    processPartition: vi.fn(async (_partition: number) => []),
  };
  const pendingIndex = {
    ensureAllGroups: vi.fn(async () => {}),
    summary: vi.fn(async (_partition: number) => ({
      count: 0,
      oldestMs: undefined as number | undefined,
    })),
  };
  const ready = vi.fn(async () => {});
  const recovery = vi.fn(() => ({ worker, pendingIndex, store, ready }));
  return { runtime: { recovery }, recovery, store, worker, pendingIndex };
}

describe("initSnapshotRecoveryWorker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.__snapshotRecoveryShutdownRegistered__ = undefined;
    signalsEmitter.removeAllListeners();
  });

  afterEach(() => {
    signalsEmitter.removeAllListeners();
    global.__snapshotRecoveryShutdownRegistered__ = undefined;
    vi.useRealTimers();
  });

  it("is a no-op when there is no snapshot store runtime", () => {
    const isEnabled = vi.fn(() => true);
    initSnapshotRecoveryWorker({ getRuntime: () => undefined, isEnabled, intervalMs: 1_000 });

    expect(isEnabled).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(signalsEmitter.listenerCount("SIGTERM")).toBe(0);
  });

  it("is a no-op when the sweep flag is off for this replica", () => {
    const fake = fakeRuntime();
    initSnapshotRecoveryWorker({
      getRuntime: () => fake.runtime,
      isEnabled: () => false,
      intervalMs: 1_000,
    });

    expect(fake.recovery).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(signalsEmitter.listenerCount("SIGTERM")).toBe(0);
  });

  it("starts a leased sweep over every partition and stops it on SIGTERM", async () => {
    const fake = fakeRuntime();
    initSnapshotRecoveryWorker({
      getRuntime: () => fake.runtime,
      isEnabled: () => true,
      intervalMs: 1_000,
    });

    expect(signalsEmitter.listenerCount("SIGTERM")).toBe(1);
    expect(signalsEmitter.listenerCount("SIGINT")).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    // Construction alone does no Redis work; the interval drives it.
    expect(fake.store.acquireOrRenewRecoveryLease).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await settleMicrotasks();
    expect(fake.pendingIndex.ensureAllGroups).toHaveBeenCalledTimes(1);
    expect(fake.worker.processPartition).toHaveBeenCalledTimes(PENDING_PARTITION_COUNT);
    // Every replica reads as one stable consumer, never a per-process hostname:pid.
    const consumers = new Set(fake.worker.processPartition.mock.calls.map((call) => call[1]));
    expect([...consumers]).toEqual(["sweeper"]);
    // The lease is taken at the start of the tick (a fast tick never reaches the quarter-TTL renewal),
    // under one owner, with a TTL floored at 60s.
    expect(fake.store.acquireOrRenewRecoveryLease).toHaveBeenCalledTimes(1);
    const owners = new Set(fake.store.acquireOrRenewRecoveryLease.mock.calls.map(([o]) => o));
    expect(owners.size).toBe(1);
    expect(fake.store.acquireOrRenewRecoveryLease.mock.calls[0][1]).toBe(60_000);
    const [owner] = owners;

    // The handler resolves only after the lease release has.
    let finishRelease!: () => void;
    fake.store.releaseRecoveryLease.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishRelease = resolve))
    );
    const [handler] = signalsEmitter.listeners("SIGTERM") as Array<() => Promise<void>>;
    let handlerReturned = false;
    const handled = handler().then(() => {
      handlerReturned = true;
    });
    expect(vi.getTimerCount()).toBe(1); // only the release timeout; the interval is cleared
    expect(fake.store.releaseRecoveryLease).toHaveBeenCalledWith(owner);
    await settleMicrotasks();
    expect(handlerReturned).toBe(false);
    finishRelease();
    await handled;
    expect(handlerReturned).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const acquiresAtStop = fake.store.acquireOrRenewRecoveryLease.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fake.store.acquireOrRenewRecoveryLease.mock.calls.length).toBe(acquiresAtStop);
  });

  it("gives up waiting for a hung lease release after the shutdown timeout", async () => {
    const fake = fakeRuntime();
    fake.store.releaseRecoveryLease.mockImplementation(() => new Promise<void>(() => {}));
    initSnapshotRecoveryWorker({
      getRuntime: () => fake.runtime,
      isEnabled: () => true,
      intervalMs: 1_000,
    });
    const [handler] = signalsEmitter.listeners("SIGTERM") as Array<() => Promise<void>>;
    let handlerReturned = false;
    const handled = handler().then(() => {
      handlerReturned = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(handlerReturned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await handled;
    expect(handlerReturned).toBe(true);
  });

  it("records sweep latency and the pending gauges on its registry", async () => {
    const fake = fakeRuntime();
    fake.pendingIndex.summary.mockImplementation(async (partition: number) => ({
      count: 1,
      oldestMs: partition === 7 ? Date.now() - 30_000 : Date.now() - 1_000,
    }));
    const register = new Registry();
    initSnapshotRecoveryWorker({
      getRuntime: () => fake.runtime,
      isEnabled: () => true,
      intervalMs: 1_000,
      register,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await settleMicrotasks();
    // A metrics sink makes the sweeper read every partition's depth/age summary.
    expect(fake.pendingIndex.summary).toHaveBeenCalledTimes(PENDING_PARTITION_COUNT);
    const exposition = await register.metrics();
    expect(exposition).toContain(
      `snapshot_store_recovery_pending_count ${PENDING_PARTITION_COUNT}`
    );
    expect(exposition).toContain("snapshot_store_recovery_oldest_pending_age_seconds 30");
    expect(exposition).toContain("snapshot_store_recovery_sweep_seconds_count 1");
  });

  it("does not register twice on a dev hot reload", () => {
    const fake = fakeRuntime();
    const opts = { getRuntime: () => fake.runtime, isEnabled: () => true, intervalMs: 1_000 };
    initSnapshotRecoveryWorker(opts);
    initSnapshotRecoveryWorker(opts);

    expect(fake.recovery).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(signalsEmitter.listenerCount("SIGTERM")).toBe(1);
  });
});
