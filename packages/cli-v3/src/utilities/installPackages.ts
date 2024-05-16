import { execa } from "execa";
import { join } from "node:path";
import { readJSONFile, writeJSONFile } from "./fileSystem";
import { logger } from "./logger";

export type InstallPackagesOptions = { cwd?: string };

export async function installPackages(
  packages: Record<string, string>,
  options?: InstallPackagesOptions
) {
  const cwd = options?.cwd ?? process.cwd();

  logger.debug("Installing packages", { packages });

  await setPackageJsonDeps(join(cwd, "package.json"), packages);

  await execa(
    "npm",
    ["install", "--install-strategy", "nested", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd,
      stderr: "pipe",
    }
  );
}

// Expects path to be in the format:
//  - source-map-support/register.js
//  - @opentelemetry/api
//  - zod
//
// With the result being:
//  - source-map-support
//  - @opentelemetry/api
//  - zod
export function detectPackageNameFromImportPath(path: string): string {
  if (path.startsWith("@")) {
    return path.split("/").slice(0, 2).join("/");
  } else {
    return path.split("/")[0] as string;
  }
}

/**
 * Removes the workspace prefix from a version string.
 * @param version - The version string to strip the workspace prefix from.
 * @returns The version string without the workspace prefix.
 * @example
 * stripWorkspaceFromVersion("workspace:1.0.0") // "1.0.0"
 * stripWorkspaceFromVersion("1.0.0") // "1.0.0"
 */
export function stripWorkspaceFromVersion(version: string) {
  return version.replace(/^workspace:/, "");
}

export function parsePackageName(packageSpecifier: string): { name: string; version?: string } {
  let name: string | undefined;
  let version: string | undefined;

  // Check if the package is scoped
  if (packageSpecifier.startsWith("@")) {
    const atIndex = packageSpecifier.indexOf("@", 1);
    // If a version is included
    if (atIndex !== -1) {
      name = packageSpecifier.slice(0, atIndex);
      version = packageSpecifier.slice(atIndex + 1);
    } else {
      name = packageSpecifier;
    }
  } else {
    const [packageName, packageVersion] = packageSpecifier.split("@");

    if (typeof packageName === "string") {
      name = packageName;
    }

    version = packageVersion;
  }

  if (!name) {
    return { name: packageSpecifier };
  }

  return { name, version };
}

async function setPackageJsonDeps(path: string, deps: Record<string, string>) {
  try {
    const existingPackageJson = await readJSONFile(path);

    const newPackageJson = {
      ...existingPackageJson,
      dependencies: {
        ...deps,
      },
    };

    await writeJSONFile(path, newPackageJson);
  } catch (error) {
    const defaultPackageJson = {
      name: "temp",
      version: "1.0.0",
      description: "",
      dependencies: deps,
    };

    await writeJSONFile(path, defaultPackageJson);
  }
}
