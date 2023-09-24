import { Framework, ProjectInstallOptions } from "..";
import { InstallPackage } from "../../utils/addDependencies";
import { pathExists, someFileExists } from "../../utils/fileSystem";
import { PackageManager } from "../../utils/getUserPkgManager";
import pathModule from "path";
import { getPathAlias } from "../../utils/pathAlias";
import { createFileFromTemplate } from "../../utils/createFileFromTemplate";
import { templatesPath } from "../../paths";
import { logger } from "../../utils/logger";
import { readPackageJson } from "../../utils/readPackageJson";
import { standardWatchFilePaths } from "../watchConfig";

export class Astro implements Framework {
  id = "astro";
  name = "Astro";

  async isMatch(path: string, packageManager: PackageManager): Promise<boolean> {
    const configFilenames = [
      "astro.config.js",
      "astro.config.mjs",
      "astro.config.cjs",
      "astro.config.ts",
    ];
    //check for astro.config.mjs
    const hasConfigFile = await someFileExists(path, configFilenames);
    if (hasConfigFile) {
      return true;
    }

    //check for the astro package
    const packageJsonContent = await readPackageJson(path);
    if (packageJsonContent?.dependencies?.astro) {
      return true;
    }

    return false;
  }

  async dependencies(): Promise<InstallPackage[]> {
    return [
      { name: "@trigger.dev/sdk", tag: "latest" },
      { name: "@trigger.dev/astro", tag: "latest" },
      { name: "@trigger.dev/react", tag: "latest" },
    ];
  }

  possibleEnvFilenames(): string[] {
    return [".env", ".env.development"];
  }

  async install(path: string, { typescript, endpointSlug }: ProjectInstallOptions): Promise<void> {
    const pathAlias = await getPathAlias({
      projectPath: path,
      isTypescriptProject: typescript,
      extraDirectories: ["src"],
    });
    const templatesDir = pathModule.join(templatesPath(), "astro");
    const srcFolder = pathModule.join(path, "src");
    const fileExtension = typescript ? ".ts" : ".js";

    //create src/pages/api/trigger.js
    const apiRoutePath = pathModule.join(srcFolder, "pages", "api", `trigger${fileExtension}`);
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

    //src/trigger.js
    const triggerFilePath = pathModule.join(srcFolder, `trigger${fileExtension}`);
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

    //src/jobs/example.js
    const exampleJobFilePath = pathModule.join(srcFolder, "jobs", `example${fileExtension}`);
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

    //src/jobs/index.js
    const jobsIndexFilePath = pathModule.join(srcFolder, "jobs", `index${fileExtension}`);
    const jobsIndexResult = await createFileFromTemplate({
      templatePath: pathModule.join(templatesDir, "jobsIndex.js"),
      replacements: {
        jobsPathPrefix: pathAlias ? pathAlias + "/" : "../",
      },
      outputPath: jobsIndexFilePath,
    });
    if (!jobsIndexResult.success) {
      throw new Error("Failed to create jobs index file");
    }
    logger.success(`✔ Created jobs index at ${jobsIndexFilePath}`);
  }

  async postInstall(path: string, options: ProjectInstallOptions): Promise<void> {
    logger.warn(
      `⚠︎ Ensure your astro.config output is "server" or "hybrid":\nhttps://docs.astro.build/en/guides/server-side-rendering/#enabling-ssr-in-your-project`
    );
  }

  defaultHostnames = ["localhost", "[::]"];
  defaultPorts = [4321, 4322, 4323, 4324];
  watchFilePaths = standardWatchFilePaths;
  watchIgnoreRegex = /(node_modules)/;
}
