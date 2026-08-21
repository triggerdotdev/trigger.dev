import { describe, expect, it } from "vitest";
import {
  RunId,
  WaitpointId,
  BatchId,
  SnapshotId,
  generateRunOpsId,
  generateRunOpsIdV2,
} from "./friendlyId.js";
import {
  ownerEngine,
  classifyResidency,
  classifyKind,
  isClassifiable,
  resolveShard,
} from "./runOpsResidency.js";

const SAMPLES = 50_000; // property-scale; CI-fast. (Bump locally toward "millions" for deeper coverage.)
/** Every legal gen-2 shard char: the full DNS-safe lowercase range. */
const SHARD_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

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

  it("discriminates on the version char, not length: 26+'1' → NEW, 26+'2' → NEW (gen-2)", () => {
    const v1 = "a".repeat(24) + "e1";
    expect(ownerEngine(v1)).toBe("NEW");
    expect(ownerEngine("a".repeat(24) + "e2")).toBe("NEW"); // gen-2: shard "e"
    expect(ownerEngine("a".repeat(24) + "e3")).toBe("LEGACY"); // unknown version char
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

describe("resolveShard — the gen-2 refinement inside the dedicated family", () => {
  it("returns the shard char for every legal gen-2 shard key, friendly + internal", () => {
    for (const c of SHARD_CHARS) {
      const id = generateRunOpsIdV2(c);
      expect(resolveShard(id)).toBe(c);
      expect(resolveShard(RunId.toFriendlyId(id))).toBe(c);
      expect(resolveShard(WaitpointId.toFriendlyId(id))).toBe(c);
      expect(resolveShard(BatchId.toFriendlyId(id))).toBe(c);
    }
  });

  it("returns 'new' for a gen-1 v1 body, friendly + internal", () => {
    for (const region of [undefined, "us-east-1", "us-west-2", "eu-central-1"]) {
      const id = generateRunOpsId(region);
      expect(resolveShard(id)).toBe("new");
      expect(resolveShard(RunId.toFriendlyId(id))).toBe("new");
    }
  });

  it("returns 'legacy' for a cuid, a nanoid, a pre-cutover base62 id and malformed input", () => {
    expect(resolveShard(RunId.generate().id)).toBe("legacy"); // cuid, 25
    expect(resolveShard(RunId.generate().friendlyId)).toBe("legacy");
    expect(resolveShard("123456789abcdefghijkm")).toBe("legacy"); // nanoid, 21
    expect(resolveShard("b".repeat(27))).toBe("legacy"); // pre-cutover base62, 27
    for (const bad of [
      "",
      "x".repeat(24) + "01", // 'x' outside base32hex
      "x".repeat(24) + "02", // 'x' outside base32hex, gen-2 version
      "A".repeat(25) + "1", // uppercase
      "A".repeat(25) + "2", // uppercase, gen-2 version
      "a".repeat(24) + "-1", // hyphen positional char
      "a".repeat(24) + "-2", // hyphen positional char, gen-2 version
      "a".repeat(26), // 26 chars, no version marker
      "a".repeat(24) + "e3", // unknown version char
      "x".repeat(40),
    ]) {
      expect(resolveShard(bad)).toBe("legacy");
    }
  });

  it("never throws, for any input string", () => {
    for (const input of ["", "x", "-".repeat(26), " ".repeat(26), "\u{1F642}".repeat(26)]) {
      expect(() => resolveShard(input)).not.toThrow();
    }
  });

  it("the reserved keys are multi-char, so no single-char shard key can collide", () => {
    for (const reserved of ["legacy", "new"]) {
      expect(reserved.length).toBeGreaterThan(1);
      expect(SHARD_CHARS).not.toContain(reserved);
    }
  });
});

describe("gen-2 ids classify NEW — the dedicated family widens in meaning only", () => {
  it("a gen-2 id is NEW / runOpsId across id-shape co-located entities", () => {
    for (const util of [RunId, WaitpointId, BatchId]) {
      const id = generateRunOpsIdV2("a");
      const friendlyId = util.toFriendlyId(id);
      expect(ownerEngine(id)).toBe("NEW");
      expect(ownerEngine(friendlyId)).toBe("NEW");
      expect(classifyResidency(id)).toBe("NEW");
      expect(classifyKind(id)).toBe("runOpsId");
      expect(isClassifiable(id)).toBe(true);
    }
  });

  it("26+'2' is now a gen-2 shard route, not LEGACY (the one deliberate flip)", () => {
    const genTwo = "a".repeat(24) + "e2";
    expect(ownerEngine(genTwo)).toBe("NEW");
    expect(resolveShard(genTwo)).toBe("e");
  });

  it("three-way disjointness: cuid, gen-1 v1 and gen-2 never cross-classify", () => {
    for (let i = 0; i < SAMPLES; i++) {
      const cuid = RunId.generate().id;
      const v1 = generateRunOpsId();
      const v2 = generateRunOpsIdV2(SHARD_CHARS[i % SHARD_CHARS.length]!);

      expect(ownerEngine(cuid)).toBe("LEGACY");
      expect(resolveShard(cuid)).toBe("legacy");

      expect(ownerEngine(v1)).toBe("NEW");
      expect(resolveShard(v1)).toBe("new");

      expect(ownerEngine(v2)).toBe("NEW");
      expect(resolveShard(v2)).toBe(SHARD_CHARS[i % SHARD_CHARS.length]);
    }
  });
});
