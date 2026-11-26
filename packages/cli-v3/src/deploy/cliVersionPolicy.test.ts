import { describe, expect, it } from "vitest";
import { cliVersionPolicyWarning, readCliVersionPolicy } from "./cliVersionPolicy.js";

const now = new Date("2027-01-01T00:00:00.000Z");
const minimum = "4.5.20";
const policy = { minimum, enforced_from: "2027-01-16T00:00:00.000Z" };

describe("cliVersionPolicyWarning", () => {
  // Catches: showing the enforcement day itself, or a local-time day, instead of the last UTC day deploys still work.
  it("names the minimum, the last supported day and the upgrade command", () => {
    const warning = cliVersionPolicyWarning(policy, "4.5.13", now);
    expect(warning).toContain("v4.5.20");
    expect(warning).toContain("15 Jan 2027");
    expect(warning).toContain("npx trigger.dev@latest update");

    const offset = { minimum, enforced_from: "2027-09-02T12:00:00+02:00" };
    expect(cliVersionPolicyWarning(offset, "4.5.13", now)).toContain("1 Sep 2027");
  });

  // Catches: the CLI disagreeing with the server, which rejects from the date on and exempts only 0.0.0-* prereleases.
  it("warns exactly when the server would still accept the deploy but the policy applies", () => {
    expect(cliVersionPolicyWarning(policy, "4.5.20-rc.1", now)).toBeDefined();
    expect(cliVersionPolicyWarning(policy, "0.0.0", now)).toBeDefined();
    expect(
      cliVersionPolicyWarning(policy, "4.5.13", new Date(policy.enforced_from))
    ).toBeUndefined();
    expect(cliVersionPolicyWarning(policy, "0.0.0-prerelease-20261120", now)).toBeUndefined();
    expect(cliVersionPolicyWarning(policy, "4.5.20", now)).toBeUndefined();
    expect(
      cliVersionPolicyWarning({ ...policy, minimum: ">=4.5.20" }, "4.5.13", now)
    ).toBeUndefined();
    expect(cliVersionPolicyWarning(undefined, "4.5.13", now)).toBeUndefined();
  });
});

describe("readCliVersionPolicy", () => {
  // Catches: the build server's run, attached to its deployment, reading the settings or printing a second warning.
  it("never reads the settings for a run attached to an existing deployment", async () => {
    expect(
      await readCliVersionPolicy(
        () => {
          throw new Error("fetchSettings must not be called");
        },
        { attachedToDeployment: true }
      )
    ).toBeUndefined();
  });

  // Catches: a slow or failing deploy-settings read throwing into the deploy instead of skipping the warning.
  it("fails open when the settings cannot be read", async () => {
    const standalone = { attachedToDeployment: false };
    expect(
      await readCliVersionPolicy(async () => {
        throw new Error("The operation was aborted due to timeout");
      }, standalone)
    ).toBeUndefined();
    expect(
      await readCliVersionPolicy(async () => ({ success: false, statusCode: 429 }), standalone)
    ).toBeUndefined();
  });
});
