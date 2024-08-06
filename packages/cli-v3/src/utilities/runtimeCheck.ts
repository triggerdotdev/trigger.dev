import { logger } from "./logger.js";

/**
 * This function is used by the dev CLI to make sure that the runtime is compatible
 */
export function runtimeCheck(minimumMajor: number, minimumMinor: number) {
  // Check if the runtime is Node.js
  if (typeof process === "undefined") {
    throw "The dev CLI can only be run in a Node.js compatible environment";
  }

  // Check if the runtime version is compatible
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);

  const isBun = typeof process.versions.bun === "string";

  if (major < minimumMajor || (major === minimumMajor && minor < minimumMinor)) {
    if (isBun) {
      throw `The dev CLI requires at least Node.js ${minimumMajor}.${minimumMinor}. You are running Bun ${process.versions.bun}, which is compatible with Node.js ${process.versions.node}`;
    } else {
      throw `The dev CLI requires at least Node.js ${minimumMajor}.${minimumMinor}. You are running Node.js ${process.versions.node}`;
    }
  }

  logger.debug(
    `Node.js version: ${process.versions.node}${isBun ? ` (Bun ${process.versions.bun})` : ""}`
  );
}
