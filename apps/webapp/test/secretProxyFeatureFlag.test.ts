import { describe, expect, it, vi } from "vitest";

vi.mock("~/v3/globalFlagsRegistry.server", () => ({
  globalFlagsRegistry: { current: () => ({ secretProxy: true }) },
}));

import { secretProxyEnabled } from "~/services/secretProxy/featureFlag.server";

describe("secretProxyEnabled", () => {
  // Catches: a global flag (or a cold global cache) deciding protection for an org with proxy-only values.
  it("ignores the global value and requires an org override", () => {
    expect(secretProxyEnabled(null)).toBe(false);
    expect(secretProxyEnabled({})).toBe(false);
    expect(secretProxyEnabled({ secretProxy: "true" })).toBe(false);
    expect(secretProxyEnabled({ secretProxy: true })).toBe(true);
  });
});
