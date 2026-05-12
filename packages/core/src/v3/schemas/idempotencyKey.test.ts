import { describe, it, expect } from "vitest";
import {
  BatchTriggerTaskItem,
  CreateBatchRequestBody,
  CreateInputStreamWaitpointRequestBody,
  CreateSessionStreamWaitpointRequestBody,
  CreateWaitpointTokenRequestBody,
  TriggerTaskRequestBody,
  WaitForDurationRequestBody,
} from "./api.js";

// These tests verify the zod-level character cap (.max(2048)) on schemas whose
// idempotencyKey lands against a unique composite index downstream. The cap
// itself is a JS-string-length check, so the constants below are chosen to
// exercise the boundary cleanly — high entropy isn't required for this layer.
const TOO_LONG = "x".repeat(3000);
const AT_LIMIT = "x".repeat(2048);
const SDK_HASH = "a".repeat(64); // shape of idempotencyKeys.create() output

describe("idempotencyKey length validation", () => {
  describe("TriggerTaskRequestBody", () => {
    it("rejects an idempotencyKey over 2048 characters with a clear message", () => {
      const result = TriggerTaskRequestBody.safeParse({
        payload: {},
        options: { idempotencyKey: TOO_LONG },
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0]!;
        expect(issue.path).toEqual(["options", "idempotencyKey"]);
        expect(issue.message).toBe("idempotencyKey must be 2048 characters or less");
      }
    });

    it("accepts an idempotencyKey at the 2048-character limit", () => {
      const result = TriggerTaskRequestBody.safeParse({
        payload: {},
        options: { idempotencyKey: AT_LIMIT },
      });

      expect(result.success).toBe(true);
    });

    it("accepts the SDK-generated 64-character hash", () => {
      const result = TriggerTaskRequestBody.safeParse({
        payload: {},
        options: { idempotencyKey: SDK_HASH },
      });

      expect(result.success).toBe(true);
    });
  });

  describe("BatchTriggerTaskItem", () => {
    it("rejects an idempotencyKey over 2048 characters", () => {
      const result = BatchTriggerTaskItem.safeParse({
        task: "my-task",
        payload: {},
        options: { idempotencyKey: TOO_LONG },
      });

      expect(result.success).toBe(false);
    });

    it("accepts an idempotencyKey at the 2048-character limit", () => {
      const result = BatchTriggerTaskItem.safeParse({
        task: "my-task",
        payload: {},
        options: { idempotencyKey: AT_LIMIT },
      });

      expect(result.success).toBe(true);
    });
  });

  describe("CreateBatchRequestBody", () => {
    it("rejects an idempotencyKey over 2048 characters with a clear message", () => {
      const result = CreateBatchRequestBody.safeParse({
        runCount: 1,
        idempotencyKey: TOO_LONG,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0]!;
        expect(issue.path).toEqual(["idempotencyKey"]);
        expect(issue.message).toBe("idempotencyKey must be 2048 characters or less");
      }
    });

    it("accepts an idempotencyKey at the 2048-character limit", () => {
      const result = CreateBatchRequestBody.safeParse({
        runCount: 1,
        idempotencyKey: AT_LIMIT,
      });

      expect(result.success).toBe(true);
    });
  });

  describe("CreateWaitpointTokenRequestBody", () => {
    it("rejects an idempotencyKey over 2048 characters with a clear message", () => {
      const result = CreateWaitpointTokenRequestBody.safeParse({
        idempotencyKey: TOO_LONG,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0]!;
        expect(issue.path).toEqual(["idempotencyKey"]);
        expect(issue.message).toBe("idempotencyKey must be 2048 characters or less");
      }
    });

    it("accepts an idempotencyKey at the 2048-character limit", () => {
      const result = CreateWaitpointTokenRequestBody.safeParse({
        idempotencyKey: AT_LIMIT,
      });

      expect(result.success).toBe(true);
    });
  });

  describe("CreateInputStreamWaitpointRequestBody", () => {
    it("rejects an idempotencyKey over 2048 characters with a clear message", () => {
      const result = CreateInputStreamWaitpointRequestBody.safeParse({
        streamId: "stream_1",
        idempotencyKey: TOO_LONG,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0]!;
        expect(issue.path).toEqual(["idempotencyKey"]);
        expect(issue.message).toBe("idempotencyKey must be 2048 characters or less");
      }
    });
  });

  describe("CreateSessionStreamWaitpointRequestBody", () => {
    it("rejects an idempotencyKey over 2048 characters with a clear message", () => {
      const result = CreateSessionStreamWaitpointRequestBody.safeParse({
        session: "session_1",
        io: "out",
        idempotencyKey: TOO_LONG,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0]!;
        expect(issue.path).toEqual(["idempotencyKey"]);
        expect(issue.message).toBe("idempotencyKey must be 2048 characters or less");
      }
    });
  });

  describe("WaitForDurationRequestBody", () => {
    it("rejects an idempotencyKey over 2048 characters with a clear message", () => {
      const result = WaitForDurationRequestBody.safeParse({
        date: new Date(),
        idempotencyKey: TOO_LONG,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.issues[0]!;
        expect(issue.path).toEqual(["idempotencyKey"]);
        expect(issue.message).toBe("idempotencyKey must be 2048 characters or less");
      }
    });
  });
});
