import { afterEach, describe, expect, it } from "vitest";
import { RunId, WaitpointId, SnapshotId, setKsuidMintEnabled } from "./friendlyId.js";
import {
  ownerEngine,
  classifyResidency,
  classifyKind,
  isClassifiable,
  UnclassifiableRunId,
} from "./runOpsResidency.js";

afterEach(() => setKsuidMintEnabled(false)); // never leak mint-flag state across tests

const SAMPLES = 50_000; // property-scale; CI-fast. (Bump locally toward "millions" for deeper coverage.)

describe("ownerEngine — residency classifier", () => {
  it("cuid-length ids (mint flag OFF) classify LEGACY, friendly + internal", () => {
    setKsuidMintEnabled(false);
    for (const util of [RunId, WaitpointId]) {
      const { id, friendlyId } = util.generate();
      expect(ownerEngine(id)).toBe("LEGACY");
      expect(ownerEngine(friendlyId)).toBe("LEGACY"); // strips run_/waitpoint_ prefix
      expect(classifyResidency(id)).toBe("LEGACY"); // alias agrees
      expect(classifyKind(id)).toBe("cuid");
      expect(isClassifiable(id)).toBe(true);
    }
  });

  it("ksuid-length ids (mint flag ON) classify NEW, friendly + internal", () => {
    setKsuidMintEnabled(true);
    for (const util of [RunId, WaitpointId]) {
      const { id, friendlyId } = util.generate();
      expect(ownerEngine(id)).toBe("NEW");
      expect(ownerEngine(friendlyId)).toBe("NEW");
      expect(classifyResidency(id)).toBe("NEW");
      expect(classifyKind(id)).toBe("ksuid");
    }
  });

  it("disjointness: no cuid sample is ever NEW, no ksuid sample is ever LEGACY", () => {
    for (let i = 0; i < SAMPLES; i++) {
      setKsuidMintEnabled(false);
      expect(ownerEngine(RunId.generate().id)).toBe("LEGACY");
      setKsuidMintEnabled(true);
      expect(ownerEngine(RunId.generate().id)).toBe("NEW");
    }
  });

  it("throws UnclassifiableRunId on malformed lengths (24, 26, 28, empty)", () => {
    for (const bad of ["", "x".repeat(24), "x".repeat(26), "x".repeat(28), "x".repeat(40)]) {
      expect(() => ownerEngine(bad)).toThrow(UnclassifiableRunId);
    }
  });

  it("error carries the offending value + length for diagnostics", () => {
    try {
      ownerEngine("x".repeat(26));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(UnclassifiableRunId);
      expect((e as UnclassifiableRunId).message).toContain("26");
    }
  });

  it("SnapshotId (always cuid, even with flag ON) classifies LEGACY — proves snapshot needs no residency key", () => {
    setKsuidMintEnabled(true);
    expect(ownerEngine(SnapshotId.generate().id)).toBe("LEGACY");
  });
});
