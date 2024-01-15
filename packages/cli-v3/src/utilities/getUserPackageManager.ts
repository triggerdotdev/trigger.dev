import pathModule from "path";
import { pathExists } from "./fileSystem";

export type PackageManager = "npm" | "pnpm" | "yarn";

export async function getUserPackageManager(path: string): Promise<PackageManager> {
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

async function detectPackageManagerFromArtifacts(path: string): Promise<PackageManager> {
  const packageFiles = [
    { name: "yarn.lock", pm: "yarn" } as const,
    { name: "pnpm-lock.yaml", pm: "pnpm" } as const,
    { name: "package-lock.json", pm: "npm" } as const,
    { name: "npm-shrinkwrap.json", pm: "npm" } as const,
  ];

  for (const { name, pm } of packageFiles) {
    const exists = await pathExists(pathModule.join(path, name));
    if (exists) {
      return pm;
    }
  }

  throw new Error("Could not detect package manager from artifacts");
}
