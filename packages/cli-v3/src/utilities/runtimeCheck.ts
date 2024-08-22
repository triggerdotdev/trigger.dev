import { chalkError } from "./cliOutput.js";
import { logger } from "./logger.js";

export type RuntimeMinimumVersion = {
  major: number;
  minor: number;
};

const REQUIRED_MINIMUM_VERSIONS: RuntimeMinimumVersion[] = [
  { major: 18, minor: 20 },
  { major: 20, minor: 5 },
];
/**
 * This function is used by the dev CLI to make sure that the runtime is compatible
 */
export function runtimeChecks() {
  const checks = REQUIRED_MINIMUM_VERSIONS.map((version) => runtimeCheck(version));

  // If any of the checks passed, we are good to go
  if (checks.some((check) => check.ok)) {
    return;
  }

  // Get the first failed check
  const failedCheck = checks.find((check) => !check.ok);

  if (!failedCheck) {
    return;
  }

  logger.log(`${chalkError("X Error:")} ${failedCheck.message}`);
  process.exit(1);
}

type CheckResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      message: string;
    };

function runtimeCheck(version: RuntimeMinimumVersion): CheckResult {
  // Check if the runtime is Node.js
  if (typeof process === "undefined") {
    return {
      ok: false,
      message: "The dev CLI can only be run in a Node.js compatible environment",
    };
  }

  // Check if the runtime version is compatible
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);

  const isBun = typeof process.versions.bun === "string";

  if (major < version.major || (major === version.major && minor < version.minor)) {
    if (isBun) {
      return {
        ok: false,
        message: `The dev CLI requires at least Node.js ${version.major}.${version.minor}. You are running Bun ${process.versions.bun}, which is compatible with Node.js ${process.versions.node}`,
      };
    } else {
      return {
        ok: false,
        message: `The dev CLI requires at least Node.js ${version.major}.${version.minor}. You are running Node.js ${process.versions.node}`,
      };
    }
  }

  logger.debug(
    `Node.js version: ${process.versions.node}${isBun ? ` (Bun ${process.versions.bun})` : ""}`
  );

  return { ok: true };
}
