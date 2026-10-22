import { describe, expect, it } from "vitest";
import {
  OverrideConcurrencyLimitBoundsBody,
  type OverrideConcurrencyLimitKeyBody,
  OverrideConcurrencyLimitRequestBody,
} from "./queues.js";

function messagesOf(result: ReturnType<typeof OverrideConcurrencyLimitRequestBody.safeParse>) {
  if (result.success) return [];
  const collect = (issues: { message: string; errors?: unknown }[]): string[] =>
    issues.flatMap((issue) => {
      const nested = (issue as { errors?: { message: string }[][] }).errors;
      return nested ? nested.flatMap((branch) => collect(branch)) : [issue.message];
    });
  return collect(result.error.issues);
}

describe("OverrideConcurrencyLimitRequestBody", () => {
  describe("limit bounds", () => {
    it("accepts perKey, total, or both", () => {
      expect(OverrideConcurrencyLimitRequestBody.parse({ perKey: 3 })).toEqual({ perKey: 3 });
      expect(OverrideConcurrencyLimitRequestBody.parse({ total: 5 })).toEqual({ total: 5 });
      expect(OverrideConcurrencyLimitRequestBody.parse({ perKey: 3, total: 5 })).toEqual({
        perKey: 3,
        total: 5,
      });
    });

    it("rejects an empty body, through the request schema and the bounds schema alone", () => {
      const result = OverrideConcurrencyLimitRequestBody.safeParse({});
      expect(result.success).toBe(false);
      expect(messagesOf(result)).toEqual(["Provide at least one of `perKey` or `total`"]);
      expect(OverrideConcurrencyLimitBoundsBody.safeParse({}).success).toBe(false);
      expect(OverrideConcurrencyLimitBoundsBody.safeParse({ total: 5 }).success).toBe(true);
    });

    it("rejects ttl without a concurrencyKey", () => {
      const result = OverrideConcurrencyLimitRequestBody.safeParse({ perKey: 3, ttl: "1d" });
      expect(result.success).toBe(false);
      expect(messagesOf(result)).toEqual([
        "`ttl` only applies to a per-key override; pass `concurrencyKey` with it",
      ]);
    });

    it("bounds a value to 0..100000 integers", () => {
      expect(OverrideConcurrencyLimitRequestBody.safeParse({ perKey: -1 }).success).toBe(false);
      expect(OverrideConcurrencyLimitRequestBody.safeParse({ total: 100001 }).success).toBe(false);
      expect(OverrideConcurrencyLimitRequestBody.safeParse({ perKey: 1.5 }).success).toBe(false);
      expect(OverrideConcurrencyLimitRequestBody.safeParse({ perKey: 0 }).success).toBe(true);
    });
  });

  describe("per-key cap", () => {
    it("accepts a key with perKey and an optional ttl", () => {
      expect(
        OverrideConcurrencyLimitRequestBody.parse({ concurrencyKey: "session-1", perKey: 3 })
      ).toEqual({ concurrencyKey: "session-1", perKey: 3 });
      expect(
        OverrideConcurrencyLimitRequestBody.parse({
          concurrencyKey: "session-1",
          perKey: 0,
          ttl: "2h",
        })
      ).toEqual({ concurrencyKey: "session-1", perKey: 0, ttl: "2h" });
      expect(
        OverrideConcurrencyLimitRequestBody.parse({ concurrencyKey: "s", perKey: 1, ttl: 60 })
      ).toEqual({ concurrencyKey: "s", perKey: 1, ttl: 60 });
    });

    it("coerces a numeric key to a string, as trigger does", () => {
      expect(OverrideConcurrencyLimitRequestBody.parse({ concurrencyKey: 42, perKey: 3 })).toEqual({
        concurrencyKey: "42",
        perKey: 3,
      });
    });

    it("rejects total alongside a key", () => {
      const result = OverrideConcurrencyLimitRequestBody.safeParse({
        concurrencyKey: "s",
        perKey: 3,
        total: 5,
      });
      expect(result.success).toBe(false);
      expect(messagesOf(result)).toEqual([
        "`total` is not per key; omit it when overriding one concurrencyKey",
      ]);
    });

    it("rejects a key without perKey", () => {
      expect(
        messagesOf(OverrideConcurrencyLimitRequestBody.safeParse({ concurrencyKey: "s" }))
      ).toEqual(["A per-key override needs `perKey`"]);
      expect(
        messagesOf(OverrideConcurrencyLimitRequestBody.safeParse({ concurrencyKey: "s", total: 5 }))
      ).toEqual([
        "A per-key override needs `perKey`",
        "`total` is not per key; omit it when overriding one concurrencyKey",
      ]);
    });

    it("rejects an empty or overlong key and a non-positive ttl", () => {
      expect(
        OverrideConcurrencyLimitRequestBody.safeParse({ concurrencyKey: "", perKey: 3 }).success
      ).toBe(false);
      expect(
        OverrideConcurrencyLimitRequestBody.safeParse({
          concurrencyKey: "k".repeat(129),
          perKey: 3,
        }).success
      ).toBe(false);
      expect(
        OverrideConcurrencyLimitRequestBody.safeParse({ concurrencyKey: "s", perKey: 3, ttl: 0 })
          .success
      ).toBe(false);
      expect(
        OverrideConcurrencyLimitRequestBody.safeParse({ concurrencyKey: "s", perKey: 3, ttl: -1 })
          .success
      ).toBe(false);
    });
  });

  describe("types", () => {
    it("is a union of the two shapes, exclusive on concurrencyKey", () => {
      type Body = typeof OverrideConcurrencyLimitRequestBody._output;
      const keyed: Body = { concurrencyKey: "s", perKey: 3, ttl: "1d" };
      const bounds: Body = { perKey: 3, total: 5 };
      // @ts-expect-error total is not per key
      const keyedWithTotal: Body = { concurrencyKey: "s", perKey: 3, total: 5 };
      // @ts-expect-error a per-key override needs perKey
      const keyedWithoutPerKey: Body = { concurrencyKey: "s" };
      // @ts-expect-error ttl only applies to a per-key override
      const boundsWithTtl: Body = { perKey: 3, ttl: "1d" };
      const keyBody: typeof OverrideConcurrencyLimitKeyBody._output = keyed;
      expect([
        keyed,
        bounds,
        keyedWithTotal,
        keyedWithoutPerKey,
        boundsWithTtl,
        keyBody,
      ]).toHaveLength(6);
    });
  });
});
