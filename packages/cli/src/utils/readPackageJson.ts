import pathModule from "path";
import { type PackageJson } from "type-fest";
import { readJSONFile } from "./fileSystem.js";

export async function readPackageJson(directory: string): Promise<PackageJson | undefined> {
  const packageJsonPath = pathModule.join(directory, "package.json");
  return readJSONFile(packageJsonPath)
    .then((f) => f as PackageJson)
    .catch(() => undefined);
}
