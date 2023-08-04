import pathModule from "path";
import { type PackageJson } from "type-fest";
import { readJSONFile } from "./fileSystem.js";

/** Detects if the project is a Next.js project at path  */
export async function detectNextJsProject(path: string): Promise<boolean> {
  // Checks for the presence of the next package in the package.json file
  try {
    const packageJsonPath = pathModule.join(path, "package.json");
    const packageJsonContent = (await readJSONFile(packageJsonPath)) as PackageJson;

    return packageJsonContent.dependencies?.next !== undefined;
  } catch (error) {
    // If the package.json file doesn't exist… then they've run it in the wrong folder
    return false;
  }
}
