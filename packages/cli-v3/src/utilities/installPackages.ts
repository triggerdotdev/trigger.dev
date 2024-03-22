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

  const childProcess = execa(
    "npm",
    ["install", "--install-strategy", "nested", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd,
      stderr: "inherit",
    }
  );

  await new Promise<void>((res, rej) => {
    childProcess.on("error", (e) => rej(e));
    childProcess.on("close", () => res());
  });

  await childProcess;

  return;
}

async function getPackageVersion(path: string) {
  try {
    const packageJsonPath = join(path, "package.json");
    const packageJson = await readJSONFile(packageJsonPath);

    return packageJson.version;
  } catch (error) {
    return undefined;
  }
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

export function parsePackageName(packageSpecifier: string): { name: string; version?: string } {
  const parts = packageSpecifier.split("@");

  if (parts.length === 1 && typeof parts[0] === "string") {
    return { name: parts[0] };
  }

  if (parts.length === 2 && typeof parts[0] === "string" && typeof parts[1] === "string") {
    return { name: parts[0], version: parts[1] };
  }

  return { name: packageSpecifier };
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
