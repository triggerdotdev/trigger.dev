import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../apiClient/index.js";
import { StandardRealtimeStreamsManager } from "./manager.js";

// The cache lives on a private method to keep `pipe()` callers from having
// to thread cache concerns. Tests exercise it via bracket-notation to keep
// the assertions tight on cache contracts and avoid spinning up real
// `StreamsWriterV1`/`StreamsWriterV2` infrastructure (HTTP requests, S2
// connections) for what is purely an in-memory dedup check.
type GetCached = (
  runId: string,
  key: string,
  requestOptions?: undefined
) => Promise<{ version: string; headers?: Record<string, string> }>;

function getCached(manager: StandardRealtimeStreamsManager, runId: string, key: string) {
  return (manager as unknown as { getCachedCreateStream: GetCached }).getCachedCreateStream(
    runId,
    key
  );
}

function makeApiClient(impl: () => Promise<{ version: string; headers?: Record<string, string> }>) {
  const spy = vi.fn(impl);
  const client = { createStream: spy } as unknown as ApiClient;
  return { client, spy };
}

describe("StandardRealtimeStreamsManager createStream cache", () => {
  it("dedupes repeated calls for the same (runId, key)", async () => {
    const { client, spy } = makeApiClient(async () => ({ version: "v1", headers: {} }));
    const manager = new StandardRealtimeStreamsManager(client, "http://localhost");

    const p1 = getCached(manager, "run-1", "chat");
    const p2 = getCached(manager, "run-1", "chat");

    expect(p1).toBe(p2);
    expect(spy).toHaveBeenCalledTimes(1);
    await Promise.all([p1, p2]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("issues a separate PUT for each distinct stream key on the same run", async () => {
    const { client, spy } = makeApiClient(async () => ({ version: "v1", headers: {} }));
    const manager = new StandardRealtimeStreamsManager(client, "http://localhost");

    await Promise.all([
      getCached(manager, "run-1", "chat"),
      getCached(manager, "run-1", "tool-output"),
    ]);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, "run-1", "self", "chat", undefined);
    expect(spy).toHaveBeenNthCalledWith(2, "run-1", "self", "tool-output", undefined);
  });

  it("issues a separate PUT for each distinct run, even with the same key", async () => {
    const { client, spy } = makeApiClient(async () => ({ version: "v1", headers: {} }));
    const manager = new StandardRealtimeStreamsManager(client, "http://localhost");

    await Promise.all([getCached(manager, "run-1", "chat"), getCached(manager, "run-2", "chat")]);

    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("evicts on failure so the next call retries instead of returning a poisoned entry", async () => {
    const spy = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ version: "v1", headers: {} });
    const client = { createStream: spy } as unknown as ApiClient;
    const manager = new StandardRealtimeStreamsManager(client, "http://localhost");

    await expect(getCached(manager, "run-1", "chat")).rejects.toThrow("boom");

    const retried = await getCached(manager, "run-1", "chat");

    expect(retried).toEqual({ version: "v1", headers: {} });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("reset() clears cached entries so the next call re-PUTs", async () => {
    const { client, spy } = makeApiClient(async () => ({ version: "v1", headers: {} }));
    const manager = new StandardRealtimeStreamsManager(client, "http://localhost");

    await getCached(manager, "run-1", "chat");
    expect(spy).toHaveBeenCalledTimes(1);

    manager.reset();

    await getCached(manager, "run-1", "chat");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("evictCreateStreamIfStale clears the matching entry so the next call re-PUTs", async () => {
    const { client, spy } = makeApiClient(async () => ({ version: "v1", headers: {} }));
    const manager = new StandardRealtimeStreamsManager(client, "http://localhost");

    // Prime the cache and capture which promise was stored.
    const cachedPromise = getCached(manager, "run-1", "chat");
    await cachedPromise;
    expect(spy).toHaveBeenCalledTimes(1);

    // Simulate the reactive invalidation path that `pipe()` runs when a
    // writer's `wait()` rejects.
    (
      manager as unknown as {
        evictCreateStreamIfStale: (runId: string, key: string, expected: Promise<unknown>) => void;
      }
    ).evictCreateStreamIfStale("run-1", "chat", cachedPromise);

    await getCached(manager, "run-1", "chat");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("evictCreateStreamIfStale is a no-op when the cache holds a different promise", async () => {
    const { client, spy } = makeApiClient(async () => ({ version: "v1", headers: {} }));
    const manager = new StandardRealtimeStreamsManager(client, "http://localhost");

    const original = getCached(manager, "run-1", "chat");
    await original;

    // A different promise (e.g. from a concurrent caller that already
    // refreshed) shouldn't trigger eviction.
    const stalePromise = Promise.resolve({ version: "v1", headers: {} });
    (
      manager as unknown as {
        evictCreateStreamIfStale: (runId: string, key: string, expected: Promise<unknown>) => void;
      }
    ).evictCreateStreamIfStale("run-1", "chat", stalePromise);

    // Cache should still hold the original entry; next call is a hit.
    await getCached(manager, "run-1", "chat");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
