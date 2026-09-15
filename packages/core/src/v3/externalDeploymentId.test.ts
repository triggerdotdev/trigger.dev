import { describe, expect, it } from "vitest";
import {
  discoverPlatformCommitSha,
  isAutomaticSkewProtectionEnabled,
  normalizeExternalDeploymentId,
  PLATFORM_COMMIT_SHA_ENV_VARS,
  resolveExternalDeploymentId,
} from "./externalDeploymentId.js";

function reader(vars: Record<string, string | undefined>) {
  return (name: string) => vars[name];
}

const SHA = "fa1eade47b73733d6312d5abfad33ce9e4068081";

describe("normalizeExternalDeploymentId", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeExternalDeploymentId(`  ${SHA}  `)).toBe(SHA);
  });

  it.each([undefined, "", "   ", "\t\n"])("treats %j as absent", (value) => {
    expect(normalizeExternalDeploymentId(value)).toBeUndefined();
  });

  it("accepts exactly 128 characters", () => {
    expect(normalizeExternalDeploymentId("a".repeat(128))).toBe("a".repeat(128));
  });

  it("skips a value longer than 128 characters rather than sending it to be rejected", () => {
    expect(normalizeExternalDeploymentId("a".repeat(129))).toBeUndefined();
  });

  it("measures the length limit after trimming", () => {
    expect(normalizeExternalDeploymentId(`  ${"a".repeat(128)}  `)).toBe("a".repeat(128));
  });
});

describe("isAutomaticSkewProtectionEnabled", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["True", true],
    [" 1 ", true],
    ["0", false],
    ["false", false],
    ["", false],
    ["yes", false],
    ["on", false],
    ["2", false],
    [undefined, false],
  ])("reads %j as %s", (value, expected) => {
    expect(
      isAutomaticSkewProtectionEnabled(reader({ TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION: value }))
    ).toBe(expected);
  });
});

describe("discoverPlatformCommitSha", () => {
  it("returns undefined when nothing is set", () => {
    expect(discoverPlatformCommitSha(reader({}))).toBeUndefined();
  });

  it.each(PLATFORM_COMMIT_SHA_ENV_VARS)("reads %s", (name) => {
    expect(discoverPlatformCommitSha(reader({ [name]: SHA }))).toBe(SHA);
  });

  it("prefers a hosting variable over a CI variable, because it describes the deployment that is running", () => {
    expect(
      discoverPlatformCommitSha(
        reader({ VERCEL_GIT_COMMIT_SHA: "vercel-sha", GITHUB_SHA: "github-sha" })
      )
    ).toBe("vercel-sha");
  });

  it("prefers a CI variable over the generic tier", () => {
    expect(
      discoverPlatformCommitSha(reader({ GITHUB_SHA: "github-sha", GIT_HASH: "generic-sha" }))
    ).toBe("github-sha");
  });

  it("falls back to the generic tier when nothing named is set", () => {
    expect(discoverPlatformCommitSha(reader({ COMMIT_HASH: "generic-sha" }))).toBe("generic-sha");
  });

  it("honours the full hosting order", () => {
    const order = [
      "VERCEL_GIT_COMMIT_SHA",
      "RAILWAY_GIT_COMMIT_SHA",
      "RENDER_GIT_COMMIT",
      "CF_PAGES_COMMIT_SHA",
      "WORKERS_CI_COMMIT_SHA",
      "COMMIT_REF",
      "AWS_COMMIT_ID",
      "HEROKU_BUILD_COMMIT",
      "HEROKU_SLUG_COMMIT",
      "KOYEB_GIT_SHA",
    ];

    const vars: Record<string, string> = Object.fromEntries(order.map((n) => [n, n]));

    for (const expected of order) {
      expect(discoverPlatformCommitSha(reader(vars))).toBe(expected);
      delete vars[expected];
    }
  });

  it("skips an empty value and keeps looking", () => {
    expect(discoverPlatformCommitSha(reader({ VERCEL_GIT_COMMIT_SHA: "", GITHUB_SHA: SHA }))).toBe(
      SHA
    );
  });

  it("skips an over-long value and keeps looking, rather than sending something that will be rejected", () => {
    expect(
      discoverPlatformCommitSha(reader({ VERCEL_GIT_COMMIT_SHA: "a".repeat(129), GITHUB_SHA: SHA }))
    ).toBe(SHA);
  });

  it("never reads CACHED_COMMIT_REF, which is the previous build's SHA", () => {
    expect(PLATFORM_COMMIT_SHA_ENV_VARS).not.toContain("CACHED_COMMIT_REF");
    expect(discoverPlatformCommitSha(reader({ CACHED_COMMIT_REF: SHA }))).toBeUndefined();
  });
});

describe("resolveExternalDeploymentId", () => {
  it("returns nothing when no source yields a value", () => {
    expect(resolveExternalDeploymentId({ read: reader({}) })).toBeUndefined();
  });

  it("honours a per-call id above everything else", () => {
    expect(
      resolveExternalDeploymentId({
        explicit: "per-call",
        clientConfig: "per-client",
        read: reader({
          TRIGGER_EXTERNAL_DEPLOYMENT_ID: "per-env",
          TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION: "1",
          VERCEL_GIT_COMMIT_SHA: "discovered",
        }),
      })
    ).toBe("per-call");
  });

  it("honours a per-client id above the environment and discovery", () => {
    expect(
      resolveExternalDeploymentId({
        clientConfig: "per-client",
        read: reader({
          TRIGGER_EXTERNAL_DEPLOYMENT_ID: "per-env",
          TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION: "1",
          VERCEL_GIT_COMMIT_SHA: "discovered",
        }),
      })
    ).toBe("per-client");
  });

  it("honours TRIGGER_EXTERNAL_DEPLOYMENT_ID above discovery", () => {
    expect(
      resolveExternalDeploymentId({
        read: reader({
          TRIGGER_EXTERNAL_DEPLOYMENT_ID: "per-env",
          TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION: "1",
          VERCEL_GIT_COMMIT_SHA: "discovered",
        }),
      })
    ).toBe("per-env");
  });

  it("honours an explicit id with no opt-in variable at all — the gate is on discovery, not pinning", () => {
    expect(
      resolveExternalDeploymentId({
        read: reader({ TRIGGER_EXTERNAL_DEPLOYMENT_ID: "per-env" }),
      })
    ).toBe("per-env");
  });

  it("honours a per-call id with no opt-in variable", () => {
    expect(resolveExternalDeploymentId({ explicit: "per-call", read: reader({}) })).toBe(
      "per-call"
    );
  });

  it("discovers when the opt-in is exactly 1", () => {
    expect(
      resolveExternalDeploymentId({
        read: reader({
          TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION: "1",
          VERCEL_GIT_COMMIT_SHA: SHA,
        }),
      })
    ).toBe(SHA);
  });

  it.each(["0", "", "false", "yes", undefined])(
    "discovers nothing when the opt-in reads %j",
    (gate) => {
      expect(
        resolveExternalDeploymentId({
          read: reader({
            TRIGGER_AUTOMATIC_SKEW_VERSION_PROTECTION: gate,
            VERCEL_GIT_COMMIT_SHA: SHA,
          }),
        })
      ).toBeUndefined();
    }
  );

  it("normalises whatever it resolves, whichever tier produced it", () => {
    expect(resolveExternalDeploymentId({ explicit: `  ${SHA} `, read: reader({}) })).toBe(SHA);
    expect(resolveExternalDeploymentId({ clientConfig: `  ${SHA} `, read: reader({}) })).toBe(SHA);
    expect(
      resolveExternalDeploymentId({ read: reader({ TRIGGER_EXTERNAL_DEPLOYMENT_ID: ` ${SHA} ` }) })
    ).toBe(SHA);
  });

  it("falls through a blank higher tier to a usable lower one", () => {
    expect(
      resolveExternalDeploymentId({
        explicit: "   ",
        clientConfig: "",
        read: reader({ TRIGGER_EXTERNAL_DEPLOYMENT_ID: SHA }),
      })
    ).toBe(SHA);
  });

  it("reads the environment on every call, so a variable appearing later is picked up", () => {
    const vars: Record<string, string | undefined> = {};
    const read = reader(vars);

    expect(resolveExternalDeploymentId({ read })).toBeUndefined();

    vars.TRIGGER_EXTERNAL_DEPLOYMENT_ID = SHA;

    expect(resolveExternalDeploymentId({ read })).toBe(SHA);
  });

  it("reads nothing at all when the reader refuses, which is how a non-inheriting SDK scope behaves", () => {
    expect(
      resolveExternalDeploymentId({
        read: () => undefined,
      })
    ).toBeUndefined();
  });
});
