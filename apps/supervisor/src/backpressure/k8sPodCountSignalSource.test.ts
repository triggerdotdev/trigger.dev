import { describe, it, expect } from "vitest";
import { K8sPodCountSignalSource } from "./k8sPodCountSignalSource.js";
import { podCountFromList, withTimeout } from "../clients/kubernetes.js";

describe("podCountFromList", () => {
  it("returns items.length when the list is not truncated", () => {
    expect(podCountFromList({ items: [{}], metadata: {} })).toBe(1);
  });

  it("returns zero for an empty namespace", () => {
    expect(podCountFromList({ items: [], metadata: {} })).toBe(0);
  });

  it("adds remainingItemCount when the list is truncated", () => {
    const list = { items: [{}], metadata: { _continue: "tok", remainingItemCount: 24492 } };
    expect(podCountFromList(list)).toBe(24493);
  });

  it("throws when truncated but remainingItemCount is absent", () => {
    const list = { items: [{}], metadata: { _continue: "tok" } };
    expect(() => podCountFromList(list)).toThrow(/remainingItemCount/);
  });

  it("throws when truncated but remainingItemCount is negative", () => {
    const list = { items: [{}], metadata: { _continue: "tok", remainingItemCount: -1 } };
    expect(() => podCountFromList(list)).toThrow(/remainingItemCount/);
  });
});

describe("withTimeout", () => {
  it("rejects once the deadline passes", async () => {
    await expect(withTimeout(new Promise(() => {}), 10, "pod count list")).rejects.toThrow(
      /timed out/
    );
  });

  it("passes a value through when it settles first", async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, "pod count list")).resolves.toBe(7);
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
