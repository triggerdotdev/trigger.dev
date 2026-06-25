import { describe, expect, it } from "vitest";
import { validateFeatureFlagInvariants } from "~/v3/featureFlags";

describe("validateFeatureFlagInvariants (runTableV2 requires native realtime)", () => {
  it("allows runTableV2 on when realtimeBackend is native", () => {
    expect(
      validateFeatureFlagInvariants({ runTableV2: true, realtimeBackend: "native" }).ok
    ).toBe(true);
  });

  it("rejects runTableV2 on while realtimeBackend is electric", () => {
    expect(
      validateFeatureFlagInvariants({ runTableV2: true, realtimeBackend: "electric" }).ok
    ).toBe(false);
  });

  it("rejects runTableV2 on while realtimeBackend is shadow", () => {
    expect(
      validateFeatureFlagInvariants({ runTableV2: true, realtimeBackend: "shadow" }).ok
    ).toBe(false);
  });

  it("rejects runTableV2 on when realtimeBackend is unset (defaults to electric)", () => {
    expect(validateFeatureFlagInvariants({ runTableV2: true }).ok).toBe(false);
  });

  it("allows runTableV2 off or absent regardless of backend", () => {
    expect(validateFeatureFlagInvariants({ runTableV2: false }).ok).toBe(true);
    expect(
      validateFeatureFlagInvariants({ runTableV2: false, realtimeBackend: "electric" }).ok
    ).toBe(true);
    expect(validateFeatureFlagInvariants({}).ok).toBe(true);
    expect(validateFeatureFlagInvariants({ realtimeBackend: "electric" }).ok).toBe(true);
  });

  it("ignores a stringified runTableV2 (strict boolean) and does not constrain", () => {
    // runTableV2 is a strict z.boolean(); a stringified "true" fails the parse,
    // so the invariant treats it as not-enabled (the write would be rejected by
    // the flag schema itself before reaching here).
    expect(
      validateFeatureFlagInvariants({ runTableV2: "true", realtimeBackend: "electric" }).ok
    ).toBe(true);
  });
});
