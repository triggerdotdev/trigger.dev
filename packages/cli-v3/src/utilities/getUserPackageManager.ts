import { findUp } from "find-up";
import { basename } from "path";
import { logger } from "./logger";

export type PackageManager = "npm" | "pnpm" | "yarn";
export const LOCKFILES = {
  npm: "package-lock.json",
  npmShrinkwrap: "npm-shrinkwrap.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
};

export async function getUserPackageManager(path: string): Promise<PackageManager> {
  const packageManager = await detectPackageManager(path);
  logger.debug("Detected package manager", { packageManager });
  return packageManager;
}

async function detectPackageManager(path: string): Promise<PackageManager> {
  try {
    return await detectPackageManagerFromArtifacts(path);
  } catch (error) {
    return detectPackageManagerFromCurrentCommand();
  }
}

function detectPackageManagerFromCurrentCommand(): PackageManager {
  // This environment variable is set by npm and yarn but pnpm seems less consistent
  const userAgent = process.env.npm_config_user_agent;

  if (userAgent) {
    if (userAgent.startsWith("yarn")) {
      return "yarn";
    } else if (userAgent.startsWith("pnpm")) {
      return "pnpm";
    } else {
      return "npm";
    }
  } else {
    // If no user agent is set, assume npm
    return "npm";
  }
}

export async function detectPackageManagerFromArtifacts(path: string): Promise<PackageManager> {
  const foundPath = await findUp(Object.values(LOCKFILES), { cwd: path });

  if (!foundPath) {
    throw new Error("Could not detect package manager from artifacts");
  }

  logger.debug("Found path from package manager artifacts", { foundPath });

  switch (basename(foundPath)) {
    case LOCKFILES.yarn:
      return "yarn";
    case LOCKFILES.pnpm:
      return "pnpm";
    case LOCKFILES.npm:
    case LOCKFILES.npmShrinkwrap:
      return "npm";
    default:
      throw new Error(`Unhandled package manager detection path: ${foundPath}`);
  }
}
