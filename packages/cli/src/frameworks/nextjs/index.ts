import fs from "fs/promises";
import pathModule from "path";
import boxen from "boxen";
import { Framework } from "..";
import { templatesPath } from "../../paths";
import { InstallPackage } from "../../utils/addDependencies";
import { createFileFromTemplate } from "../../utils/createFileFromTemplate";
import { pathExists, someFileExists } from "../../utils/fileSystem";
import { PackageManager } from "../../utils/getUserPkgManager";
import { logger } from "../../utils/logger";
import { getPathAlias } from "../../utils/pathAlias";
import { readPackageJson } from "../../utils/readPackageJson";
import { standardWatchFilePaths } from "../watchConfig";
import { telemetryClient } from "../../telemetry/telemetry";
import { detectMiddlewareUsage } from "./middleware";

export class NextJs implements Framework {
  id = "nextjs";
  name = "Next.js";

  async isMatch(path: string, packageManager: PackageManager): Promise<boolean> {
    const hasNextConfigFile = await detectNextConfigFile(path);
    if (hasNextConfigFile) {
      return true;
    }

    return await detectNextDependency(path);
  }

  async dependencies(): Promise<InstallPackage[]> {
    return [
      { name: "@trigger.dev/sdk", tag: "latest" },
      { name: "@trigger.dev/nextjs", tag: "latest" },
      { name: "@trigger.dev/react", tag: "latest" },
    ];
  }

  possibleEnvFilenames(): string[] {
    return [".env.local", ".env"];
  }

  publicKeyEnvName = "NEXT_PUBLIC_TRIGGER_PUBLIC_API_KEY";

  async install(
    path: string,
    options: { typescript: boolean; packageManager: PackageManager; endpointSlug: string }
  ): Promise<void> {
    const usesSrcDir = await detectUseOfSrcDir(path);
    if (usesSrcDir) {
      logger.info("📁 Detected use of src directory");
    }

    const nextJsDir = await detectPagesOrAppDir(path);
    const nextJsVersion = await detectNextVersion(path);
    const routeDir = pathModule.join(path, usesSrcDir ? "src" : "");
    const pathAlias = await getPathAlias({
      projectPath: path,
      isTypescriptProject: options.typescript,
      extraDirectories: usesSrcDir ? ["src"] : undefined,
    });
    const fileExtension = options.typescript ? ".ts" : ".js";

    if (nextJsDir === "pages") {
      const apiRoutePath = pathModule.join(routeDir, "pages", "api", `trigger${fileExtension}`);
      if (nextJsVersion && nextJsVersion !== 'latest' && nextJsVersion < "13.5") {
        await createTriggerRoute({
          path: routeDir,
          apiRoutePath,
          template: "pagesApiRoute.js",
          fileExtension,
          endpointSlug: options.endpointSlug,
          pathAlias
        });
      } else {
        await createTriggerRoute({
          path: routeDir,
          apiRoutePath,
          template: "pagesApiRouteWithConfigObject.js",
          fileExtension,
          endpointSlug: options.endpointSlug,
          pathAlias
        });
      }
    } else {
      const apiRoutePath = pathModule.join(routeDir, "app", "api", "trigger", `route${fileExtension}`);
      await createTriggerRoute({
        path: routeDir,
        apiRoutePath,
        template: "appApiRoute.js",
        fileExtension,
        endpointSlug: options.endpointSlug,
        pathAlias
      });
    }
  }

  async postInstall(
    path: string,
    options: { typescript: boolean; packageManager: PackageManager; endpointSlug: string }
  ): Promise<void> {
    const result = await detectMiddlewareUsage(path, options.typescript);
    if (result.hasMiddleware) {
      switch (result.conflict) {
        case "possible": {
          logger.warn(
            `⚠️ ⚠️ ⚠️  It looks like there might be conflicting Next.js middleware in ${result.middlewarePath} which can cause issues with Trigger.dev. Please see https://trigger.dev/docs/documentation/guides/platforms/nextjs#middleware`
          );
          telemetryClient.init.warning("middleware_conflict", { projectPath: path });
          break;
        }
        case "likely": {
          logger.warn(
            `🚨 It looks like there might be conflicting Next.js middleware in ${result.middlewarePath} which will cause issues with Trigger.dev. Please see https://trigger.dev/docs/documentation/guides/platforms/nextjs#middleware`
          );
          telemetryClient.init.warning("middleware_conflict", { projectPath: path });
          break;
        }
        default:
          break;
      }
    }
  }

  defaultHostnames = ["localhost"];
  defaultPorts = [3000, 3001, 3002];
  watchFilePaths = standardWatchFilePaths;
  watchIgnoreRegex = /(node_modules|\.next)/;
}

async function detectNextConfigFile(path: string): Promise<boolean> {
  const configFilenames = [
    "next.config.js",
    "next.config.mjs",
    "next.config.cjs",
    "next.config.ts",
  ];

  return someFileExists(path, configFilenames);
}

export async function detectNextDependency(path: string): Promise<boolean> {
  const packageJsonContent = await readPackageJson(path);
  if (!packageJsonContent) {
    return false;
  }

  if (packageJsonContent.dependencies?.next !== undefined) return true;
  if (packageJsonContent.devDependencies?.next !== undefined) return true;

  return false;
}

export async function detectUseOfSrcDir(path: string): Promise<boolean> {
  // Detects if the project is using a src directory
  try {
    await fs.access(pathModule.join(path, "src"));
    return true;
  } catch (error) {
    return false;
  }
}

export async function detectPagesOrAppDir(path: string): Promise<"pages" | "app"> {
  const withoutSrcAppPath = pathModule.join(path, "app");
  if (await pathExists(withoutSrcAppPath)) {
    return "app";
  }

  const withSrcAppPath = pathModule.join(path, "src", "app");
  if (await pathExists(withSrcAppPath)) {
    return "app";
  }

  return "pages";
}

export async function detectNextVersion(path: string) {
  const packageJsonContent = await readPackageJson(path);
  if (!packageJsonContent) {
    return null;
  }

  const versionNumberPattern = /[\d.]+|latest/;
  if (packageJsonContent.dependencies?.next !== undefined)
    return packageJsonContent.dependencies?.next?.match(versionNumberPattern)?.at(0) ?? null;
  if (packageJsonContent.devDependencies?.next !== undefined)
    return packageJsonContent.devDependencies?.next?.match(versionNumberPattern)?.at(0) ?? null;

  return null;
}

async function createTriggerRoute(options: {
  path: string,
  apiRoutePath: string,
  template: string,
  fileExtension: string,
  endpointSlug: string,
  pathAlias: string | undefined
}) {
  const { path, apiRoutePath, template, pathAlias, endpointSlug, fileExtension } = options;

  const templatesDir = pathModule.join(templatesPath(), "nextjs");
  const apiRouteResult = await createFileFromTemplate({
    templatePath: pathModule.join(templatesDir, template),
    replacements: {
      routePathPrefix: pathAlias ? pathAlias + "/" : "../../",
    },
    outputPath: apiRoutePath,
  });
  if (!apiRouteResult.success) {
    throw new Error("Failed to create API route file");
  }
  logger.success(`✔ Created API route at ${apiRoutePath}`);
  logger.info(
    boxen(`If you're deploying to Vercel, configure your max duration in ${apiRoutePath}`, {
      padding: 1,
      margin: 1,
      borderStyle: "double",
      borderColor: "magenta",
    })
  );

  await createJobsAndTriggerFile(path, endpointSlug, fileExtension, pathAlias, templatesDir);
}

async function createJobsAndTriggerFile(
  path: string,
  endpointSlug: string,
  fileExtension: string,
  pathAlias: string | undefined,
  templatesDir: string
) {
  //trigger.js or src/trigger.js
  const triggerFilePath = pathModule.join(path, `trigger${fileExtension}`);
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

  //example jobs
  const exampleDirectory = pathModule.join(path, "jobs");

  //jobs/examples.js or src/jobs/examples.js
  const exampleJobFilePath = pathModule.join(exampleDirectory, `examples${fileExtension}`);
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

  //jobs/index.js or src/jobs/index.js
  const jobsIndexFilePath = pathModule.join(exampleDirectory, `index${fileExtension}`);
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
