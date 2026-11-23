import { describe, expect, it } from "vitest";
import {
  cliVersionPolicyFor,
  evaluateCliVersion,
  parseCliVersionPolicy,
} from "~/v3/cliVersionPolicy.server";

const enforcedFrom = new Date("2027-01-15T00:00:00.000Z");
const policy = { minimum: "4.5.20", enforcedFrom };
const before = new Date("2027-01-14T23:59:59.000Z");

describe("evaluateCliVersion", () => {
  // Catches: comparing the enforcement date with the current time, which fails a deploy that started before it.
  it("rejects only deployments created on or after the enforcement date", () => {
    expect(evaluateCliVersion(policy, "4.5.19", before)).toBe("warn");
    expect(evaluateCliVersion(policy, "4.5.19", enforcedFrom)).toBe("reject");
  });

  // Catches: local 0.0.0 prerelease builds being rejected, or a real prerelease of an old version slipping through.
  it("passes 0.0.0 prereleases but not prereleases below the minimum", () => {
    expect(evaluateCliVersion(policy, "0.0.0-prerelease-20270101", enforcedFrom)).toBe("ok");
    expect(evaluateCliVersion(policy, "4.5.20-beta.1", enforcedFrom)).toBe("reject");
  });

  // Catches: a version that can't be read being rejected instead of left to the next gate.
  it("reports an unparseable version as unknown", () => {
    expect(evaluateCliVersion(policy, "4.5", enforcedFrom)).toBe("unknown");
  });
});

describe("parseCliVersionPolicy", () => {
  // Catches: a typo or a missing date in the env vars turning into rejections instead of no policy.
  it("turns the policy off without a valid minimum and date", () => {
    for (const raw of [
      { minimum: "4.5", enforcedFrom: "2027-01-15T00:00:00Z" },
      { minimum: "4.5.20" },
      { minimum: "4.5.20", enforcedFrom: "15/01/2027" },
    ]) {
      expect(parseCliVersionPolicy(raw)).toBeUndefined();
    }
  });
});

describe("cliVersionPolicyFor", () => {
  // Catches: the org flag pulling enforcement earlier, or a malformed flag exempting the org.
  it("only moves the enforcement date later", () => {
    const org = (deployCliVersionEnforcedFrom: string) => ({
      featureFlags: { deployCliVersionEnforcedFrom },
    });
    const later = "2027-03-01T00:00:00.000Z";

    expect(cliVersionPolicyFor(org(later), policy)).toEqual({
      minimum: "4.5.20",
      enforcedFrom: new Date(later),
    });
    expect(cliVersionPolicyFor(org("2026-12-01T00:00:00Z"), policy)).toEqual(policy);
    expect(cliVersionPolicyFor(org("soon"), policy)).toEqual(policy);
  });
});
