import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ApiPromise,
  ConcurrencyLimitItem,
  ConcurrencyLimitKeyItem,
  OverrideConcurrencyLimitRequestBody,
} from "@trigger.dev/core/v3";
import { concurrencyLimits } from "./index.js";

/**
 * Never called: these bodies are checked by the SDK's typecheck, whose tsconfig
 * includes every file under `src`, so a change that widens `override` back to one
 * flat shape fails to compile here. The runtime schema has its own tests in
 * `@trigger.dev/core`.
 */
function compileOnly() {
  expectTypeOf(concurrencyLimits.override("subagents", { perKey: 3 })).toEqualTypeOf<
    ApiPromise<ConcurrencyLimitItem>
  >();
  expectTypeOf(concurrencyLimits.override("subagents", { total: 50 })).toEqualTypeOf<
    ApiPromise<ConcurrencyLimitItem>
  >();
  expectTypeOf(concurrencyLimits.override("subagents", { perKey: 3, total: 50 })).toEqualTypeOf<
    ApiPromise<ConcurrencyLimitItem>
  >();
  expectTypeOf(
    concurrencyLimits.override("subagents", { concurrencyKey: "session-1", perKey: 3 })
  ).toEqualTypeOf<ApiPromise<ConcurrencyLimitKeyItem>>();
  expectTypeOf(
    concurrencyLimits.override("subagents", { concurrencyKey: "session-1", perKey: 3, ttl: "2h" })
  ).toEqualTypeOf<ApiPromise<ConcurrencyLimitKeyItem>>();
  expectTypeOf(
    concurrencyLimits.override("subagents", { concurrencyKey: "session-1", perKey: 0, ttl: 3600 })
  ).toEqualTypeOf<ApiPromise<ConcurrencyLimitKeyItem>>();

  // @ts-expect-error total is not per key
  void concurrencyLimits.override("subagents", { concurrencyKey: "k", perKey: 3, total: 5 });
  // @ts-expect-error a per-key override needs perKey
  void concurrencyLimits.override("subagents", { concurrencyKey: "k" });
  // @ts-expect-error a per-key override needs perKey
  void concurrencyLimits.override("subagents", { concurrencyKey: "k", total: 5 });
  // @ts-expect-error ttl only applies to a per-key override
  void concurrencyLimits.override("subagents", { perKey: 3, ttl: "1d" });

  const either: OverrideConcurrencyLimitRequestBody =
    Math.random() > 0.5 ? { concurrencyKey: "k", perKey: 3 } : { total: 5 };
  const eitherResult: ApiPromise<ConcurrencyLimitItem | ConcurrencyLimitKeyItem> =
    concurrencyLimits.override("subagents", either);
  void eitherResult;
}

describe("concurrencyLimits.override types", () => {
  it("keeps the keyed and whole-limit shapes exclusive", () => {
    expect(typeof compileOnly).toBe("function");
  });
});
