import { log } from "@clack/prompts";
import { tryCatch } from "@trigger.dev/core/v3";
import type { CliVersionPolicy } from "@trigger.dev/core/v3/schemas";
import * as semver from "semver";
import { VERSION } from "../version.js";
import type { DeploySettingsResult } from "./buildPath.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

export async function readCliVersionPolicy(
  fetchSettings: () => Promise<DeploySettingsResult>,
  { attachedToDeployment }: { attachedToDeployment: boolean }
): Promise<CliVersionPolicy | undefined> {
  if (attachedToDeployment) {
    return undefined;
  }

  const [error, result] = await tryCatch(fetchSettings());
  return !error && result.success ? result.data.cli_version_policy : undefined;
}

export function warnAboutCliVersionPolicy(policy: CliVersionPolicy | undefined) {
  const warning = cliVersionPolicyWarning(policy, VERSION);
  if (warning) {
    log.warn(warning);
  }
}

export function cliVersionPolicyWarning(
  policy: CliVersionPolicy | undefined,
  cliVersion: string,
  now: Date = new Date()
): string | undefined {
  const version = semver.parse(cliVersion);
  if (!policy || !version || !semver.valid(policy.minimum)) {
    return undefined;
  }

  const isLocalPrerelease =
    version.major === 0 &&
    version.minor === 0 &&
    version.patch === 0 &&
    version.prerelease.length > 0;
  const enforcedFrom = Date.parse(policy.enforced_from);

  if (isLocalPrerelease || semver.gte(version, policy.minimum) || now.getTime() >= enforcedFrom) {
    return undefined;
  }

  return [
    `Deploys from versions below v${policy.minimum} will no longer be supported after ${lastSupportedDay(enforcedFrom)}.`,
    "Run `npx trigger.dev@latest update` to upgrade.",
  ].join("\n");
}

function lastSupportedDay(enforcedFrom: number) {
  const day = new Date(enforcedFrom - DAY_MS);
  return `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]} ${day.getUTCFullYear()}`;
}
