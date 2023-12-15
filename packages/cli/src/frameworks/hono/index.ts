import { Framework, ProjectInstallOptions } from "..";
import { InstallPackage } from "../../utils/addDependencies";
import { PackageManager } from "../../utils/getUserPkgManager";
import { logger } from "../../utils/logger";
import { readPackageJson } from "../../utils/readPackageJson";
import { standardWatchFilePaths } from "../watchConfig";
import boxen from "boxen";

export class Hono implements Framework {
  id = "hono";
  name = "Hono.dev";

  async isMatch(path: string, packageManager: PackageManager): Promise<boolean> {
    //check for the express package
    const packageJsonContent = await readPackageJson(path);
    if (packageJsonContent?.dependencies?.hono) {
      return true;
    }

    return false;
  }

  async dependencies(): Promise<InstallPackage[]> {
    return [
      { name: "@trigger.dev/sdk", tag: "latest" },
      { name: "@trigger.dev/hono", tag: "latest" },
    ];
  }

  possibleEnvFilenames(): string[] {
    return [".dev.vars", ".env"];
  }

  async install(path: string, { typescript, endpointSlug }: ProjectInstallOptions): Promise<void> {}

  async postInstall(path: string, options: ProjectInstallOptions): Promise<void> {}

  async printInstallationComplete(projectUrl: string): Promise<void> {
    logger.info(
      boxen(
        "Automatic installation isn't currently supported for Hono.dev. \nFollow the steps in our quickstart installation guide: https://trigger.dev/docs/documentation/quickstarts/hono",
        { padding: 1, margin: 1, borderStyle: "double", borderColor: "magenta" }
      )
    );
  }

  defaultHostnames = ["127.0.0.1", "localhost", "[::]"];
  defaultPorts = [3000, 8000, 80, 8080];
  watchFilePaths = standardWatchFilePaths;
  watchIgnoreRegex = /(node_modules)/;
}
