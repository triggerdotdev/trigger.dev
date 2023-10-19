import fs from "fs/promises";
import pathModule from "path";
import { readPackageJson } from "./readPackageJson";

/** Detects if the project is a Nuxt.js project at path  */
export async function detectNuxtJsProject(path: string): Promise<boolean> {
  const hasNuxtConfigFile = await detectNuxtConfigFile(path);
  if (hasNuxtConfigFile) {
    return true;
  }

  return await detectNuxtDependency(path);
}

async function detectNuxtConfigFile(path: string): Promise<boolean> {
  return fs
    .access(pathModule.join(path, "nuxt.config.ts"))
    .then(() => true)
    .catch(() => false);
}

async function detectNuxtDependency(path: string): Promise<boolean> {
  const packageJsonContent = await readPackageJson(path);
  if (!packageJsonContent) {
    return false;
  }

  return packageJsonContent.dependencies?.nuxt !== undefined;
}

