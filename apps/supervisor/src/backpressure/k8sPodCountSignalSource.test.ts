import { describe, it, expect } from "vitest";
import { parsePodCount, K8sPodCountSignalSource } from "./k8sPodCountSignalSource.js";

describe("parsePodCount", () => {
  it("reads the pods object count", () => {
    const text = [
      "# HELP apiserver_storage_objects Number of stored objects",
      "# TYPE apiserver_storage_objects gauge",
      'apiserver_storage_objects{resource="pods"} 8421',
      'apiserver_storage_objects{resource="configmaps"} 17',
    ].join("\n");
    expect(parsePodCount(text)).toBe(8421);
  });

  it("is tolerant of extra labels in any order", () => {
    const text = 'apiserver_storage_objects{group="",resource="pods",extra="x"} 12';
    expect(parsePodCount(text)).toBe(12);
  });

  it("parses scientific notation", () => {
    const text = 'apiserver_storage_objects{resource="pods"} 1.2e+04';
    expect(parsePodCount(text)).toBe(12000);
  });

  it("throws when the pods metric is absent", () => {
    const text = 'apiserver_storage_objects{resource="configmaps"} 17';
    expect(() => parsePodCount(text)).toThrow();
  });
});

function metrics(count: number): string {
  return `apiserver_storage_objects{resource="pods"} ${count}`;
}

describe("K8sPodCountSignalSource", () => {
  it("engages at the engage threshold and reports the count", async () => {
    const counts: number[] = [];
    const source = new K8sPodCountSignalSource({
      fetchMetrics: async () => metrics(10000),
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
      fetchMetrics: async () => metrics(9999),
      engageThreshold: 10000,
      releaseThreshold: 5000,
    });
    expect((await source.read()).engaged).toBe(false);
  });

  it("stays engaged in the hysteresis band, releases only below release threshold", async () => {
    let count = 10000;
    const source = new K8sPodCountSignalSource({
      fetchMetrics: async () => metrics(count),
      engageThreshold: 10000,
      releaseThreshold: 5000,
    });
    expect((await source.read()).engaged).toBe(true);  // engage
    count = 7000;
    expect((await source.read()).engaged).toBe(true);  // band -> still engaged
    count = 4999;
    expect((await source.read()).engaged).toBe(false); // below release -> off
    count = 7000;
    expect((await source.read()).engaged).toBe(false); // band again -> stays off
  });

  it("propagates scrape failures (monitor fails open on throw)", async () => {
    const source = new K8sPodCountSignalSource({
      fetchMetrics: async () => {
        throw new Error("connection refused");
      },
      engageThreshold: 10000,
      releaseThreshold: 5000,
    });
    await expect(source.read()).rejects.toThrow("connection refused");
  });
});
