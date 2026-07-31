import { describe, it, expect } from "vitest";
import { K8sPodCountSignalSource } from "./k8sPodCountSignalSource.js";
import { createPodCountFetcher } from "../clients/kubernetes.js";
import type { K8sApi } from "../clients/kubernetes.js";

function apiReturning(list: unknown): K8sApi {
  return { core: { listNamespacedPod: async () => list } } as unknown as K8sApi;
}

describe("createPodCountFetcher", () => {
  it("returns items.length when the list is not truncated", async () => {
    const fetch = createPodCountFetcher(
      apiReturning({ items: [{}], metadata: {} }),
      "v4-runs",
      1000
    );
    expect(await fetch()).toBe(1);
  });

  it("returns zero for an empty namespace", async () => {
    const fetch = createPodCountFetcher(apiReturning({ items: [], metadata: {} }), "v4-runs", 1000);
    expect(await fetch()).toBe(0);
  });

  it("adds remainingItemCount when the list is truncated", async () => {
    const list = { items: [{}], metadata: { _continue: "tok", remainingItemCount: 24492 } };
    const fetch = createPodCountFetcher(apiReturning(list), "v4-runs", 1000);
    expect(await fetch()).toBe(24493);
  });

  it("throws when truncated but remainingItemCount is absent", async () => {
    const list = { items: [{}], metadata: { _continue: "tok" } };
    const fetch = createPodCountFetcher(apiReturning(list), "v4-runs", 1000);
    await expect(fetch()).rejects.toThrow(/remainingItemCount/);
  });

  it("throws when truncated but remainingItemCount is negative", async () => {
    const list = { items: [{}], metadata: { _continue: "tok", remainingItemCount: -1 } };
    const fetch = createPodCountFetcher(apiReturning(list), "v4-runs", 1000);
    await expect(fetch()).rejects.toThrow(/remainingItemCount/);
  });

  it("rejects when the list hangs past the timeout", async () => {
    const api = { core: { listNamespacedPod: () => new Promise(() => {}) } } as unknown as K8sApi;
    await expect(createPodCountFetcher(api, "v4-runs", 10)()).rejects.toThrow(/timed out/);
  });
});

describe("K8sPodCountSignalSource", () => {
  it("engages at the engage threshold and reports the count", async () => {
    const counts: number[] = [];
    const source = new K8sPodCountSignalSource({
      fetchPodCount: async () => 10000,
      engageThreshold: 10000,
      releaseThreshold: 5000,
      reportPodCount: (c) => counts.push(c),
    });
    const verdict = await source.read();
    expect(verdict.engaged).toBe(true);
    expect(typeof verdict.ts).toBe("number");
    expect(counts).toEqual([10000]);
  });

  it("does not engage below the engage threshold", async () => {
    const source = new K8sPodCountSignalSource({
      fetchPodCount: async () => 9999,
      engageThreshold: 10000,
      releaseThreshold: 5000,
    });
    expect((await source.read()).engaged).toBe(false);
  });

  it("stays engaged in the hysteresis band, releases only below release threshold", async () => {
    let count = 10000;
    const source = new K8sPodCountSignalSource({
      fetchPodCount: async () => count,
      engageThreshold: 10000,
      releaseThreshold: 5000,
    });
    expect((await source.read()).engaged).toBe(true); // engage
    count = 7000;
    expect((await source.read()).engaged).toBe(true); // band -> still engaged
    count = 4999;
    expect((await source.read()).engaged).toBe(false); // below release -> off
    count = 7000;
    expect((await source.read()).engaged).toBe(false); // band again -> stays off
  });

  it("propagates fetch failures (monitor fails open on throw)", async () => {
    const source = new K8sPodCountSignalSource({
      fetchPodCount: async () => {
        throw new Error("connection refused");
      },
      engageThreshold: 10000,
      releaseThreshold: 5000,
    });
    await expect(source.read()).rejects.toThrow("connection refused");
  });
});
