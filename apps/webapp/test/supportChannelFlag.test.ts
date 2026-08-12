import { describe, expect, it } from "vitest";
import { resolveSupportChannelEnabled } from "~/services/supportChannelFlag";

describe("resolveSupportChannelEnabled", () => {
  it("is off when nothing is set", () => {
    expect(resolveSupportChannelEnabled(undefined, undefined)).toBe(false);
    expect(resolveSupportChannelEnabled({}, {})).toBe(false);
  });

  it("follows the global flag when the org has no override", () => {
    expect(resolveSupportChannelEnabled({ supportChannelEnabled: true }, {})).toBe(true);
    expect(resolveSupportChannelEnabled({ supportChannelEnabled: false }, {})).toBe(false);
  });

  it("lets an org opt in ahead of a global rollout", () => {
    expect(resolveSupportChannelEnabled({}, { supportChannelEnabled: true })).toBe(true);
  });

  it("lets an org be excluded from a global rollout", () => {
    expect(
      resolveSupportChannelEnabled(
        { supportChannelEnabled: true },
        { supportChannelEnabled: false }
      )
    ).toBe(false);
  });

  it("ignores a non-boolean org override and falls back to the global flag", () => {
    expect(
      resolveSupportChannelEnabled(
        { supportChannelEnabled: true },
        { supportChannelEnabled: "yes" }
      )
    ).toBe(true);
    expect(
      resolveSupportChannelEnabled({ supportChannelEnabled: false }, { supportChannelEnabled: 1 })
    ).toBe(false);
  });

  it("treats a truthy-but-not-true global value as off", () => {
    expect(resolveSupportChannelEnabled({ supportChannelEnabled: "true" }, {})).toBe(false);
  });
});
