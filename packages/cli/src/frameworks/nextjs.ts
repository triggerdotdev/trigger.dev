import { Framework } from ".";
import { InstallPackage } from "../utils/addDependencies";
import { PackageManager } from "../utils/getUserPkgManager";
import fs from "fs/promises";
import pathModule from "path";
import { readPackageJson } from "../utils/readPackageJson";

export class NextJs implements Framework {
  id = "nextjs";
  name = "Next.js";

  async isMatch(path: string, packageManager: PackageManager): Promise<boolean> {
    const hasNextConfigFile = await detectNextConfigFile(path);
    if (hasNextConfigFile) {
      return true;
    }

    return await detectNextDependency(path);
  }

  async dependencies(): Promise<InstallPackage[]> {
    return [
      { name: "@trigger.dev/sdk", tag: "latest" },
      { name: "@trigger.dev/nextjs", tag: "latest" },
    ];
  }

  possibleEnvFilenames(): string[] {
    throw new Error("Method not implemented.");
  }
}

async function detectNextConfigFile(path: string): Promise<boolean> {
  return fs
    .access(pathModule.join(path, "next.config.js"))
    .then(() => true)
    .catch(() => false);
}

async function detectNextDependency(path: string): Promise<boolean> {
  const packageJsonContent = await readPackageJson(path);
  if (!packageJsonContent) {
    return false;
  }

  return packageJsonContent.dependencies?.next !== undefined;
}
