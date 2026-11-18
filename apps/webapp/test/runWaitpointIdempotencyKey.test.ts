import { buildJwtAbility } from "@trigger.dev/plugins";
import { describe, expect, it } from "vitest";
import { resolveRunWaitpointIdempotencyKey } from "~/utils/idempotencyKeys.server";

describe("resolveRunWaitpointIdempotencyKey", () => {
  // Catches: write-only waitpoint grants reusing another run's waitpoint and receiving its output.
  it.each([
    ["write:waitpoints"],
    ["write:waitpoints", "read:waitpoints:waitpoint_other"],
    ["read:waitpoints"],
  ])("isolates keys by run for scopes %j", (...scopes) => {
    const ability = buildJwtAbility(scopes);
    const key = resolveRunWaitpointIdempotencyKey("shared-key", "run_first", ability);

    expect(key).not.toBe("shared-key");
    expect(key).toBe(resolveRunWaitpointIdempotencyKey("shared-key", "run_first", ability));
    expect(key).not.toBe(resolveRunWaitpointIdempotencyKey("shared-key", "run_second", ability));
  });

  // Catches: callers with environment-wide waitpoint read and write grants losing shared keys.
  it("preserves environment-wide keys with both read and write grants", () => {
    const ability = buildJwtAbility(["write:waitpoints", "read:waitpoints"]);

    expect(resolveRunWaitpointIdempotencyKey("shared-key", "run_first", ability)).toBe(
      "shared-key"
    );
    expect(resolveRunWaitpointIdempotencyKey("shared-key", "run_second", ability)).toBe(
      "shared-key"
    );
  });
});
