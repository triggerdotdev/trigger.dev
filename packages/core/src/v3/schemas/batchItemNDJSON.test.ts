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
    it("accepts a missing payload", () => {
      const result = BatchTriggerTaskItem.safeParse({
        task: "user-workflow-tick",
        options: {},
      });

      expect(result.success).toBe(true);
    });

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

describe("object concurrencyKey", () => {
  const trigger = (concurrencyKey: unknown) =>
    TriggerTaskRequestBody.safeParse({ payload: {}, options: { concurrencyKey } }).success;
  const batchItem = (concurrencyKey: unknown) =>
    BatchItemNDJSON.safeParse({ index: 0, task: "t", options: { concurrencyKey } }).success;

  // Catches: an entry the record parse drops (`__proto__`) or a missing default being accepted.
  it("rejects an entry it cannot key and a missing default", () => {
    const valid = { default: "s", org: "o" };
    const proto = JSON.parse('{"default":"s","__proto__":"o"}');
    const noDefault = { org: "o" };

    expect([trigger(valid), batchItem(valid)]).toEqual([true, true]);
    expect([trigger(proto), batchItem(proto)]).toEqual([false, false]);
    expect([trigger(noDefault), batchItem(noDefault)]).toEqual([false, false]);
  });
});
