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
  try {
    REQUIRED_MINIMUM_VERSIONS.forEach((version) => runtimeCheck(version));
  } catch (e) {
    logger.log(`${chalkError("X Error:")} ${e}`);
    process.exit(1);
  }
}

function runtimeCheck(version: RuntimeMinimumVersion) {
  // Check if the runtime is Node.js
  if (typeof process === "undefined") {
    throw "The dev CLI can only be run in a Node.js compatible environment";
  }

  // Check if the runtime version is compatible
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);

  const isBun = typeof process.versions.bun === "string";

  if (major < version.major || (major === version.major && minor < version.minor)) {
    if (isBun) {
      throw `The dev CLI requires at least Node.js ${version.major}.${version.minor}. You are running Bun ${process.versions.bun}, which is compatible with Node.js ${process.versions.node}`;
    } else {
      throw `The dev CLI requires at least Node.js ${version.major}.${version.minor}. You are running Node.js ${process.versions.node}`;
    }
  }

  logger.debug(
    `Node.js version: ${process.versions.node}${isBun ? ` (Bun ${process.versions.bun})` : ""}`
  );
}
