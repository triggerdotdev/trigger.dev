import { Framework, ProjectInstallOptions } from "..";
import { InstallPackage } from "../../utils/addDependencies";
import { pathExists } from "../../utils/fileSystem";
import { PackageManager } from "../../utils/getUserPkgManager";
import pathModule from "path";
import { getPathAlias } from "../../utils/pathAlias";
import { createFileFromTemplate } from "../../utils/createFileFromTemplate";
import { templatesPath } from "../../paths";
import { logger } from "../../utils/logger";
import { readPackageJson } from "../../utils/readPackageJson";
import { standardWatchFilePaths } from "../watchConfig";

export class Remix implements Framework {
  id = "remix";
  name = "Remix";

  async isMatch(path: string, packageManager: PackageManager): Promise<boolean> {
    //check for remix.config.js
    const hasConfigFile = await pathExists(pathModule.join(path, "remix.config.js"));
    if (hasConfigFile) {
      return true;
    }

    //check for any packages starting with @remix-run
    const packageJsonContent = await readPackageJson(path);
    if (!packageJsonContent) {
      return false;
    }

    const keys = Object.keys(packageJsonContent.dependencies || {});
    const dependencyWithRemix = keys.find((key) => key.startsWith("@remix-run"));
    if (dependencyWithRemix) {
      return true;
    }

    return false;
  }

  async dependencies(): Promise<InstallPackage[]> {
    return [
      { name: "@trigger.dev/sdk", tag: "latest" },
      { name: "@trigger.dev/remix", tag: "latest" },
      { name: "@trigger.dev/react", tag: "latest" },
    ];
  }

  possibleEnvFilenames(): string[] {
    return [".env"];
  }

  async install(path: string, { typescript, endpointSlug }: ProjectInstallOptions): Promise<void> {
    const pathAlias = await getPathAlias({
      projectPath: path,
      isTypescriptProject: typescript,
      extraDirectories: ["app"],
    });
    const templatesDir = pathModule.join(templatesPath(), "remix");
    const appFolder = pathModule.join(path, "app");
    const fileExtension = typescript ? ".ts" : ".js";

    //create app/api.trigger.js
    const apiRoutePath = pathModule.join(appFolder, "routes", `api.trigger${fileExtension}`);
    const apiRouteResult = await createFileFromTemplate({
      templatePath: pathModule.join(templatesDir, "apiRoute.js"),
      replacements: {
        routePathPrefix: pathAlias ? pathAlias + "/" : "../../",
      },
      outputPath: apiRoutePath,
    });
    if (!apiRouteResult.success) {
      throw new Error("Failed to create API route file");
    }
    logger.success(`✔ Created API route at ${apiRoutePath}`);

    //app/trigger.server.js
    const triggerFilePath = pathModule.join(appFolder, `trigger.server${fileExtension}`);
    const triggerResult = await createFileFromTemplate({
      templatePath: pathModule.join(templatesDir, "trigger.js"),
      replacements: {
        endpointSlug,
      },
      outputPath: triggerFilePath,
    });
    if (!triggerResult.success) {
      throw new Error("Failed to create trigger file");
    }
    logger.success(`✔ Created Trigger client at ${triggerFilePath}`);

    //app/jobs/example.server.js
    const exampleJobFilePath = pathModule.join(appFolder, "jobs", `example.server${fileExtension}`);
    const exampleJobResult = await createFileFromTemplate({
      templatePath: pathModule.join(templatesDir, "exampleJob.js"),
      replacements: {
        jobsPathPrefix: pathAlias ? pathAlias + "/" : "../",
      },
      outputPath: exampleJobFilePath,
    });
    if (!exampleJobResult.success) {
      throw new Error("Failed to create example job file");
    }
    logger.success(`✔ Created example job at ${exampleJobFilePath}`);
  }

  async postInstall(path: string, options: ProjectInstallOptions): Promise<void> {}

  defaultHostnames = ["localhost"];
  defaultPorts = [3000, 8788, 3333];
  watchFilePaths = standardWatchFilePaths;
  watchIgnoreRegex = /(node_modules|build)/;
}
