import { describe, expect, it } from "vitest";
import { resolveInternalApiOriginEnabled } from "~/v3/featureFlags";

describe("resolveInternalApiOriginEnabled", () => {
  it("returns the global default when the org has no flags", () => {
    expect(resolveInternalApiOriginEnabled({ orgFeatureFlags: null, globalDefault: false })).toBe(
      false
    );
    expect(resolveInternalApiOriginEnabled({ orgFeatureFlags: null, globalDefault: true })).toBe(
      true
    );
    expect(resolveInternalApiOriginEnabled({ orgFeatureFlags: {}, globalDefault: true })).toBe(
      true
    );
  });

  it("lets an org override win in both directions", () => {
    expect(
      resolveInternalApiOriginEnabled({
        orgFeatureFlags: { internalApiOriginEnabled: true },
        globalDefault: false,
      })
    ).toBe(true);

    expect(
      resolveInternalApiOriginEnabled({
        orgFeatureFlags: { internalApiOriginEnabled: false },
        globalDefault: true,
      })
    ).toBe(false);
  });

  it("ignores invalid overrides and falls back to the global default", () => {
    // Strict z.boolean(): the string "false" must not coerce to an enable.
    expect(
      resolveInternalApiOriginEnabled({
        orgFeatureFlags: { internalApiOriginEnabled: "false" },
        globalDefault: false,
      })
    ).toBe(false);

    expect(
      resolveInternalApiOriginEnabled({
        orgFeatureFlags: { internalApiOriginEnabled: "true" },
        globalDefault: false,
      })
    ).toBe(false);

    expect(
      resolveInternalApiOriginEnabled({
        orgFeatureFlags: { internalApiOriginEnabled: 1 },
        globalDefault: false,
      })
    ).toBe(false);

    // The fallback must follow the global default, not hardcode false.
    expect(
      resolveInternalApiOriginEnabled({
        orgFeatureFlags: { internalApiOriginEnabled: "false" },
        globalDefault: true,
      })
    ).toBe(true);
  });

  it("ignores non-object flag containers", () => {
    expect(resolveInternalApiOriginEnabled({ orgFeatureFlags: [], globalDefault: true })).toBe(
      true
    );
    expect(resolveInternalApiOriginEnabled({ orgFeatureFlags: "junk", globalDefault: false })).toBe(
      false
    );
  });
});
