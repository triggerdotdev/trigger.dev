import { PackageManager } from "../utils/getUserPkgManager";

type Dependency = {
  name: string;
  /** Defaults to "latest" */
  tag?: string;
  /** Defaults to prod */
  type?: "dev" | "prod";
};

export interface Framework {
  id: string;
  name: string;
  isMatch(path: string, packageManager: PackageManager): Promise<boolean>;
  dependencies(path: string, packageManager: PackageManager): Promise<Dependency[]>;
  possibleEnvFilenames(): string[];
}
