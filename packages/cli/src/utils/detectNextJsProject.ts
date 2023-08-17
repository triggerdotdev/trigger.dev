import fs from "fs/promises";
import pathModule from "path";
import { readPackageJson } from "./readPackageJson";

/** Detects if the project is a Next.js project at path  */
export async function detectNextJsProject(path: string): Promise<boolean> {
  const hasNextConfigFile = await detectNextConfigFile(path);
  if (hasNextConfigFile) {
    return true;
  }

  return await detectNextDependency(path);
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
