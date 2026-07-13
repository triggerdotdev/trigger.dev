import { describe, expect, it } from "vitest";
import {
  BatchId,
  generateFriendlyId,
  generateRunOpsId,
  RunId,
} from "@trigger.dev/core/v3/isomorphic";
import { isValidFriendlyId, makeFriendlyIdValidator } from "./friendlyId";

describe("isValidFriendlyId", () => {
  it("accepts every id generation the real generators produce", () => {
    // nanoid (legacy V1), cuid (run-engine), run-ops v1 (run-ops split)
    expect(isValidFriendlyId(generateFriendlyId("run"), "run")).toBe(true);
    expect(isValidFriendlyId(RunId.generate().friendlyId, "run")).toBe(true);
    expect(isValidFriendlyId(RunId.toFriendlyId(generateRunOpsId()), "run")).toBe(true);

    expect(isValidFriendlyId(generateFriendlyId("batch"), "batch")).toBe(true);
    expect(isValidFriendlyId(BatchId.generate().friendlyId, "batch")).toBe(true);
    expect(isValidFriendlyId(BatchId.toFriendlyId(generateRunOpsId()), "batch")).toBe(true);
  });

  it("accepts each valid body length (21 nanoid, 25 cuid, 26 run-ops v1, 27 legacy base62)", () => {
    expect(isValidFriendlyId("run_" + "a".repeat(21), "run")).toBe(true);
    expect(isValidFriendlyId("run_" + "a".repeat(25), "run")).toBe(true);
    expect(isValidFriendlyId("run_" + "a".repeat(26), "run")).toBe(true);
    expect(isValidFriendlyId("run_" + "a".repeat(27), "run")).toBe(true);
  });

  it("accepts mixed-case (uppercase) legacy base62 bodies", () => {
    expect(isValidFriendlyId("run_2ABCdefGHI0123456789jklMN", "run")).toBe(true);
  });

  it("rejects the wrong prefix", () => {
    expect(isValidFriendlyId(RunId.generate().friendlyId, "batch")).toBe(false);
    expect(isValidFriendlyId("batch_" + "a".repeat(25), "run")).toBe(false);
  });

  it("rejects a bare (unprefixed) id", () => {
    expect(isValidFriendlyId("a".repeat(25), "run")).toBe(false);
  });

  it("rejects body lengths that match no generator", () => {
    for (const len of [0, 20, 22, 24, 28]) {
      expect(isValidFriendlyId("run_" + "a".repeat(len), "run")).toBe(false);
    }
  });

  it("rejects non-base62 characters in the body", () => {
    expect(isValidFriendlyId("run_" + "-".repeat(25), "run")).toBe(false);
    expect(isValidFriendlyId("run_" + "!".repeat(25), "run")).toBe(false);
    // an underscore in the body is not base62
    expect(isValidFriendlyId("run_" + "a".repeat(24) + "_", "run")).toBe(false);
  });

  it("does not treat the prefix separator as optional", () => {
    // "runX..." shares the "run" prefix but not the "run_" marker
    expect(isValidFriendlyId("run" + "a".repeat(25), "run")).toBe(false);
  });
});

describe("makeFriendlyIdValidator", () => {
  const validateRunId = makeFriendlyIdValidator("run", "Run");
  const validateBatchId = makeFriendlyIdValidator("batch", "Batch");

  it("returns undefined for a valid id of any generation", () => {
    expect(validateRunId(generateFriendlyId("run"))).toBeUndefined();
    expect(validateRunId(RunId.generate().friendlyId)).toBeUndefined();
    expect(validateRunId(RunId.toFriendlyId(generateRunOpsId()))).toBeUndefined();
    expect(validateBatchId(BatchId.toFriendlyId(generateRunOpsId()))).toBeUndefined();
  });

  it("reports a wrong prefix distinctly from a wrong shape", () => {
    expect(validateRunId("batch_" + "a".repeat(25))).toBe("Run IDs start with 'run_'");
    expect(validateRunId("run_" + "a".repeat(20))).toBe("That doesn't look like a valid run ID");
  });

  it("derives the marker and label per entity", () => {
    const validateWaitpointId = makeFriendlyIdValidator("waitpoint", "Waitpoint");
    expect(validateWaitpointId("run_" + "a".repeat(25))).toBe(
      "Waitpoint IDs start with 'waitpoint_'"
    );
    expect(validateWaitpointId("waitpoint_" + "a".repeat(20))).toBe(
      "That doesn't look like a valid waitpoint ID"
    );
  });
});
