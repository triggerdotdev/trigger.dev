import { InstallPackage } from "../utils/addDependencies";
import { PackageManager } from "../utils/getUserPkgManager";
import { NextJs } from "./nextjs";

export interface Framework {
  id: string;
  name: string;
  isMatch(path: string, packageManager: PackageManager): Promise<boolean>;
  dependencies(): Promise<InstallPackage[]>;
  possibleEnvFilenames(): string[];
}

const frameworks: Framework[] = [new NextJs()];

export const getFramework = async (
  path: string,
  packageManager: PackageManager
): Promise<Framework | undefined> => {
  for (const framework of frameworks) {
    if (await framework.isMatch(path, packageManager)) {
      return framework;
    }
  }

  return;
};

export function frameworkNames() {
  return frameworks.map((f) => f.name).join(", ");
}
