import * as semver from "semver";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG, FeatureFlagCatalog, isPlainFlagObject } from "./featureFlags";

export type DeployCliVersionPolicy = {
  minimum: string;
  enforcedFrom: Date;
};

export const UNSUPPORTED_CLI_VERSION_ERROR = "Unsupported trigger.dev version";

export type CliVersionVerdict = "ok" | "warn" | "reject" | "unknown";

function parseDate(value: unknown): Date | undefined {
  const parsed = FeatureFlagCatalog[FEATURE_FLAG.deployCliVersionEnforcedFrom].safeParse(value);
  return parsed.success ? new Date(parsed.data) : undefined;
}

export function parseCliVersionPolicy(raw: {
  minimum?: string;
  enforcedFrom?: string;
}): DeployCliVersionPolicy | undefined {
  if (!raw.minimum) return undefined;

  const minimum = semver.valid(raw.minimum);
  if (!minimum) {
    logger.error("Ignoring the CLI version policy: the minimum is not a semver version", {
      minimum: raw.minimum,
    });
    return undefined;
  }

  const enforcedFrom = raw.enforcedFrom ? parseDate(raw.enforcedFrom.trim()) : undefined;
  if (!enforcedFrom) {
    logger.error(
      "Ignoring the CLI version policy: the enforcement date is missing or not an ISO datetime",
      {
        enforcedFrom: raw.enforcedFrom,
      }
    );
    return undefined;
  }

  logger.info("CLI version policy is set", { minimum, enforcedFrom });
  return { minimum, enforcedFrom };
}

export function cliVersionPolicyFor(
  org: { featureFlags: unknown },
  policy: DeployCliVersionPolicy | undefined
): DeployCliVersionPolicy | undefined {
  if (!policy || !isPlainFlagObject(org.featureFlags)) return policy;

  const override = org.featureFlags[FEATURE_FLAG.deployCliVersionEnforcedFrom];
  if (override === undefined) return policy;

  const orgDate = parseDate(override);
  if (!orgDate) {
    logger.warn("Ignoring an invalid per-org CLI version enforcement date");
    return policy;
  }

  return orgDate > policy.enforcedFrom ? { ...policy, enforcedFrom: orgDate } : policy;
}

export function evaluateCliVersion(
  policy: DeployCliVersionPolicy | undefined,
  version: string | null | undefined,
  createdAt: Date
): CliVersionVerdict {
  if (!policy) return "ok";

  const parsed = version ? semver.parse(version) : null;
  if (!parsed) return "unknown";

  if (parsed.version.startsWith("0.0.0-") || semver.gte(parsed, policy.minimum)) return "ok";

  return createdAt >= policy.enforcedFrom ? "reject" : "warn";
}

export function checkCliVersion(
  policy: DeployCliVersionPolicy | undefined,
  version: string | null | undefined,
  createdAt: Date
): { verdict: CliVersionVerdict; rejection?: string } {
  const verdict = evaluateCliVersion(policy, version, createdAt);
  if (verdict !== "reject" || !policy || !version) return { verdict };

  return {
    verdict,
    rejection: `trigger.dev v${semver.clean(version) ?? version} is no longer supported for new deploys. Please upgrade to v${policy.minimum} or higher by running \`npx trigger.dev@latest update\`.`,
  };
}
