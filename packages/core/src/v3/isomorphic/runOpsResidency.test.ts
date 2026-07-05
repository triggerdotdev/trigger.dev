import { describe, expect, it } from "vitest";
import { RunId, WaitpointId, BatchId, SnapshotId, generateRunOpsId } from "./friendlyId.js";
import { ownerEngine, classifyResidency, classifyKind, isClassifiable } from "./runOpsResidency.js";

const SAMPLES = 50_000; // property-scale; CI-fast. (Bump locally toward "millions" for deeper coverage.)

describe("ownerEngine — residency classifier (version char at fixed position, not length)", () => {
  it("cuid ids (default mint) classify LEGACY, friendly + internal", () => {
    for (const util of [RunId, WaitpointId]) {
      const { id, friendlyId } = util.generate();
      expect(ownerEngine(id)).toBe("LEGACY");
      expect(ownerEngine(friendlyId)).toBe("LEGACY"); // strips run_/waitpoint_ prefix
      expect(classifyResidency(id)).toBe("LEGACY"); // alias agrees
      expect(classifyKind(id)).toBe("cuid");
      expect(isClassifiable(id)).toBe(true);
    }
  });

  it("run-ops v1 ids (generateRunOpsId) classify NEW, friendly + internal, across id-shape co-located entities", () => {
    for (const util of [RunId, WaitpointId, BatchId]) {
      const id = generateRunOpsId("us-east-1");
      const friendlyId = util.toFriendlyId(id);
      expect(ownerEngine(id)).toBe("NEW");
      expect(ownerEngine(friendlyId)).toBe("NEW");
      expect(classifyResidency(id)).toBe("NEW");
      expect(classifyKind(id)).toBe("runOpsId");
    }
  });

  it("discriminates on the version char, not length: 26+'1' → NEW, 26+'2' → LEGACY", () => {
    const v1 = "a".repeat(24) + "e1";
    expect(ownerEngine(v1)).toBe("NEW");
    expect(ownerEngine("a".repeat(24) + "e2")).toBe("LEGACY");
    expect(ownerEngine("a".repeat(26))).toBe("LEGACY"); // 26 chars but no version marker
  });

  it("malformed v1 shapes fall back to LEGACY (never throw)", () => {
    for (const bad of [
      "",
      "x".repeat(24) + "01", // 'x' outside base32hex
      "A".repeat(25) + "1", // uppercase
      "a".repeat(24) + "-1", // hyphen region char
      "a".repeat(27), // pre-cutover 27-char shape → LEGACY under the version rule
      "run_" + "b".repeat(27), // 27-char base62 pre-cutover friendly id → LEGACY
      "x".repeat(40),
    ]) {
      expect(ownerEngine(bad)).toBe("LEGACY");
      expect(isClassifiable(bad)).toBe(true); // classification is total now
    }
  });

  it("disjointness: no cuid sample is ever NEW, no v1 sample is ever LEGACY", () => {
    for (let i = 0; i < SAMPLES; i++) {
      expect(ownerEngine(RunId.generate().id)).toBe("LEGACY");
      expect(ownerEngine(generateRunOpsId())).toBe("NEW");
    }
  });

  it("SnapshotId (always cuid) classifies LEGACY — proves snapshot needs no residency key", () => {
    expect(ownerEngine(SnapshotId.generate().id)).toBe("LEGACY");
  });
});
