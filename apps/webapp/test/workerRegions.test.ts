import { describe, it, expect } from "vitest";
import { regionForQueue, backingForQueue, type WorkerGroupRegionRow } from "~/v3/workerRegions.server";

const groups: WorkerGroupRegionRow[] = [
  { masterQueue: "us-east-1", region: "us-east-1", workloadType: "CONTAINER", hidden: false },
  { masterQueue: "us-east-1-next", region: "us-east-1", workloadType: "MICROVM", hidden: false },
  { masterQueue: "eu-central-1", region: "eu-central-1", workloadType: "CONTAINER", hidden: false },
];

describe("regionForQueue", () => {
  it("maps a backing queue to its region", () => {
    expect(regionForQueue("us-east-1-next", groups)).toBe("us-east-1");
  });
  it("maps a container queue to its own region", () => {
    expect(regionForQueue("us-east-1", groups)).toBe("us-east-1");
  });
  it("passes an unknown queue through unchanged", () => {
    expect(regionForQueue("mystery", groups)).toBe("mystery");
  });
  it("passes through when a group has no region set", () => {
    expect(regionForQueue("x", [{ masterQueue: "x", region: null, workloadType: "CONTAINER", hidden: false }])).toBe("x");
  });
});

describe("backingForQueue", () => {
  it("finds the MICROVM backing for a region with one", () => {
    expect(backingForQueue("us-east-1", groups)).toBe("us-east-1-next");
  });
  it("returns undefined for a region with no compute backing (EU)", () => {
    expect(backingForQueue("eu-central-1", groups)).toBeUndefined();
  });
  it("returns undefined when the queue's group has no region", () => {
    expect(backingForQueue("x", [{ masterQueue: "x", region: null, workloadType: "CONTAINER", hidden: false }])).toBeUndefined();
  });
  it("ignores hidden MICROVM groups", () => {
    const g: WorkerGroupRegionRow[] = [
      { masterQueue: "us-east-1", region: "us-east-1", workloadType: "CONTAINER", hidden: false },
      { masterQueue: "us-east-1-next", region: "us-east-1", workloadType: "MICROVM", hidden: true },
    ];
    expect(backingForQueue("us-east-1", g)).toBeUndefined();
  });
});
