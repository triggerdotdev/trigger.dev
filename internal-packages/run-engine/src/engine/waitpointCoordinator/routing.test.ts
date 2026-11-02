// Pure id-shape routing. The shared parser (`parseWaitpointId`) is the ONLY authority; this file
// adds nothing to classification, it only maps the parser's verdict to a coordinator and splits
// a mixed collection without disturbing order, duplicates, or the caller's positions.
import { describe, expect, it } from "vitest";
import { generateWaitpointId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { classifyWaitpointCoordinator, partitionByResidency } from "./routing.js";

const storeRunId = generateWaitpointId("RUN");
const storeManualId = generateWaitpointId("MANUAL");
const legacyId = WaitpointId.generate().id; // a cuid — the pre-migration shape

describe("classifyWaitpointCoordinator", () => {
  it("routes a store-format id to the store coordinator", () => {
    expect(classifyWaitpointCoordinator(storeRunId)).toBe("store");
    expect(classifyWaitpointCoordinator(storeManualId)).toBe("store");
  });

  it("routes a store-format id to the store coordinator through its friendly prefix", () => {
    expect(classifyWaitpointCoordinator(`waitpoint_${storeRunId}`)).toBe("store");
  });

  it("routes a legacy cuid id to the legacy coordinator", () => {
    expect(classifyWaitpointCoordinator(legacyId)).toBe("legacy");
  });

  it("routes a foreign-prefixed id to legacy rather than reinterpreting its body", () => {
    expect(classifyWaitpointCoordinator(`run_${storeRunId}`)).toBe("legacy");
  });

  it("routes garbage to legacy (the legacy Postgres path is where it fails loud)", () => {
    expect(classifyWaitpointCoordinator("")).toBe("legacy");
    expect(classifyWaitpointCoordinator("not-an-id")).toBe("legacy");
  });
});

describe("partitionByResidency", () => {
  it("splits a mixed collection into its owning coordinators, recording original positions", () => {
    const ids = [legacyId, storeRunId, legacyId, storeManualId];
    const part = partitionByResidency(ids, (id) => id);

    expect(part.legacy).toEqual([
      { item: legacyId, index: 0 },
      { item: legacyId, index: 2 },
    ]);
    expect(part.store).toEqual([
      { item: storeRunId, index: 1 },
      { item: storeManualId, index: 3 },
    ]);
  });

  it("preserves duplicates within a group in original order", () => {
    const ids = [storeRunId, storeRunId, legacyId, storeRunId];
    const part = partitionByResidency(ids, (id) => id);
    expect(part.store.map((e) => e.index)).toEqual([0, 1, 3]);
    expect(part.store.every((e) => e.item === storeRunId)).toBe(true);
    expect(part.legacy).toEqual([{ item: legacyId, index: 2 }]);
  });

  it("handles an all-legacy collection with no store client work at all", () => {
    const ids = [legacyId, legacyId];
    const part = partitionByResidency(ids, (id) => id);
    expect(part.store).toEqual([]);
    expect(part.legacy).toHaveLength(2);
  });

  it("classifies items by an id accessor other than identity", () => {
    const items = [{ wp: legacyId }, { wp: storeRunId }];
    const part = partitionByResidency(items, (i) => i.wp);
    expect(part.legacy).toEqual([{ item: { wp: legacyId }, index: 0 }]);
    expect(part.store).toEqual([{ item: { wp: storeRunId }, index: 1 }]);
  });
});
