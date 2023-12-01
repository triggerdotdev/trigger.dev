import { InstallPackage } from "../utils/addDependencies";
import { PackageManager } from "../utils/getUserPkgManager";
import { Astro } from "./astro";
import { Express } from "./express";
import { Hono } from "./hono";
import { NextJs } from "./nextjs";
import { Remix } from "./remix";

export type ProjectInstallOptions = {
  typescript: boolean;
  packageManager: PackageManager;
  endpointSlug: string;
};

export interface Framework {
  /** A unique id for the framework */
  id: string;

  /** Display to the user in messages */
  name: string;

  /** Is this folder a project using this framework?  */
  isMatch(path: string, packageManager: PackageManager): Promise<boolean>;

  /** List of packages to install */
  dependencies(): Promise<InstallPackage[]>;

  /** Priority list of env filenames, e.g. ".env" */
  possibleEnvFilenames(): string[];

  /** Defaults to TRIGGER_PUBLIC_API_KEY */
  publicKeyEnvName?: string;

  /** Install the required files */
  install(path: string, options: ProjectInstallOptions): Promise<void>;

  /** You can check for middleware, add extra instructions, etc */
  postInstall(path: string, options: ProjectInstallOptions): Promise<void>;

  /** You can (optionally) override the initComplete messages */
  printInstallationComplete?(projectUrl: string): Promise<void>;

  /** Used by the dev command, if a hostname isn't passed in */
  defaultHostnames: string[];

  /** Used by the dev command, if a port isn't passed in */
  defaultPorts: number[];

  /** These filenames are watched for changes with the dev command, can use globs. */
  watchFilePaths: string[];

  /** These folders are ignored when watching for changes with the dev command */
  watchIgnoreRegex: RegExp;
}

/** The order of these matters. The first one that matches the folder will be used, so stricter ones should be first. */
const frameworks: Framework[] = [new NextJs(), new Remix(), new Astro(), new Express(), new Hono()];

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
