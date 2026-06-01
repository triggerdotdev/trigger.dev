import { describe, it, expect } from "vitest";
import { BatchItemNDJSON, BatchTriggerTaskItem, TriggerTaskRequestBody } from "./api.js";

describe("concurrencyKey coercion", () => {
  // Phase-2 NDJSON used to accept arbitrary shapes for `options`, so a numeric
  // concurrencyKey (a common foot-gun when callers pass
  // `concurrencyKey: payload.userId`) reached Prisma untouched and failed
  // there with PrismaClientValidationError. The schema now coerces
  // number → string at the API boundary across every trigger path.
  describe("BatchItemNDJSON", () => {
    it("coerces a numeric concurrencyKey to a string", () => {
      const result = BatchItemNDJSON.safeParse({
        index: 0,
        task: "user-workflow-tick",
        payload: { json: { userId: 51262 } },
        options: { concurrencyKey: 51262 },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.concurrencyKey).toBe("51262");
      }
    });

    it("accepts a string concurrencyKey unchanged", () => {
      const result = BatchItemNDJSON.safeParse({
        index: 0,
        task: "user-workflow-tick",
        payload: { json: { userId: 51262 } },
        options: { concurrencyKey: "user-51262" },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.concurrencyKey).toBe("user-51262");
      }
    });

    it("accepts an item with no options", () => {
      const result = BatchItemNDJSON.safeParse({
        index: 0,
        task: "user-workflow-tick",
        payload: { json: { userId: 51262 } },
      });

      expect(result.success).toBe(true);
    });

    it("rejects a non-numeric, non-string concurrencyKey", () => {
      const result = BatchItemNDJSON.safeParse({
        index: 0,
        task: "user-workflow-tick",
        options: { concurrencyKey: { nested: "object" } },
      });

      expect(result.success).toBe(false);
    });
  });

  describe("BatchTriggerTaskItem", () => {
    it("coerces a numeric concurrencyKey to a string", () => {
      const result = BatchTriggerTaskItem.safeParse({
        task: "user-workflow-tick",
        payload: { userId: 51262 },
        options: { concurrencyKey: 51262 },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.concurrencyKey).toBe("51262");
      }
    });
  });

  describe("TriggerTaskRequestBody", () => {
    it("coerces a numeric concurrencyKey to a string", () => {
      const result = TriggerTaskRequestBody.safeParse({
        payload: { userId: 51262 },
        options: { concurrencyKey: 51262 },
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.concurrencyKey).toBe("51262");
      }
    });
  });
});
