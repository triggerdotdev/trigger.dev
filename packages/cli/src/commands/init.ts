#!/usr/bin/env node

import fs from "fs/promises";
import inquirer from "inquirer";
import pathModule from "path";
import { simpleGit } from "simple-git";
import { promptApiKey, promptTriggerUrl } from "../cli/index";
import { CLOUD_API_URL, CLOUD_TRIGGER_URL, COMMAND_NAME } from "../consts";
import { Framework, frameworkNames, getFramework } from "../frameworks";
import { telemetryClient } from "../telemetry/telemetry";
import { addDependencies } from "../utils/addDependencies";
import {
  getEnvFilename,
  setApiKeyEnvironmentVariable,
  setApiUrlEnvironmentVariable,
  setPublicApiKeyEnvironmentVariable,
} from "../utils/env";
import { readJSONFile } from "../utils/fileSystem";
import { PackageManager, getUserPackageManager } from "../utils/getUserPkgManager";
import { logger } from "../utils/logger";
import { resolvePath } from "../utils/parseNameAndPath";
import { readPackageJson } from "../utils/readPackageJson";
import { renderTitle } from "../utils/renderTitle";
import { TriggerApi } from "../utils/triggerApi";
import { getJsRuntime } from "../utils/jsRuntime";

export type InitCommandOptions = {
  projectPath: string;
  triggerUrl?: string;
  endpointSlug?: string;
  apiKey?: string;
  apiUrl?: string;
};

type ResolvedOptions = Required<InitCommandOptions>;

export const initCommand = async (options: InitCommandOptions) => {
  telemetryClient.init.started(options);

  const resolvedPath = resolvePath(options.projectPath);

  // assuming nodejs by default
  let runtimeId: string = "nodejs";
  try {
    runtimeId = (await getJsRuntime(resolvedPath, logger)).id;
  } catch {}
  if (runtimeId !== "nodejs") {
    logger.error(
      `We currently only support automatic setup for NodeJS projects. This is a ${runtimeId} project. View our manual installation guides here: https://trigger.dev/docs/documentation/quickstarts/introduction`
    );
    telemetryClient.init.failed("not_supported_runtime", options);
    return;
  }

  await renderTitle(resolvedPath);

  if (options.triggerUrl === CLOUD_TRIGGER_URL) {
    logger.info(`✨ Initializing project in Trigger.dev Cloud`);
  } else if (typeof options.triggerUrl === "string") {
    logger.info(`✨ Initializing project using Trigger.dev at ${options.triggerUrl}`);
  } else {
    logger.info(`✨ Initializing Trigger.dev in project`);
  }

  const packageManager = await getUserPackageManager(resolvedPath);
  const framework = await getFramework(resolvedPath, packageManager);

  if (!framework) {
    logger.error(
      `We currently only support automatic setup for ${frameworkNames()} projects (we didn't detect one). View our manual installation guides for all frameworks: https://trigger.dev/docs/documentation/quickstarts/introduction`
    );
    telemetryClient.init.failed("not_supported_project", options);
    return;
  }
  logger.success(`✔ Detected ${framework.name} project`);

  const hasGitChanges = await detectGitChanges(resolvedPath);
  if (hasGitChanges) {
    // Warn the user that they have git changes
    logger.warn(
      "⚠️ You have uncommitted git changes, you may want to commit them before continuing."
    );
  }

  const isTypescriptProject = await detectTypescriptProject(resolvedPath);
  telemetryClient.init.isTypescriptProject(isTypescriptProject, options);

  const optionsAfterPrompts = await resolveOptionsWithPrompts(options, resolvedPath);
  const apiKey = optionsAfterPrompts.apiKey;

  if (!apiKey) {
    logger.error("You must provide an API key to continue.");
    telemetryClient.init.failed("no_api_key", optionsAfterPrompts);
    return;
  }

  const apiClient = new TriggerApi(apiKey, optionsAfterPrompts.apiUrl);
  const authorizedKey = await apiClient.whoami();

  if (!authorizedKey) {
    logger.error(
      `🛑 The API key you provided is not authorized. Try visiting your dashboard at ${optionsAfterPrompts.triggerUrl} to get a new API key.`
    );

    telemetryClient.init.failed("invalid_api_key", optionsAfterPrompts);
    return;
  }

  telemetryClient.identify(
    authorizedKey.organization.id,
    authorizedKey.project.id,
    authorizedKey.userId
  );

  const endpointSlug = authorizedKey.project.slug;
  const resolvedOptions: ResolvedOptions = { ...optionsAfterPrompts, endpointSlug };

  //install dependencies
  const dependencies = await framework.dependencies();
  await addDependencies(resolvedPath, dependencies);
  telemetryClient.init.addedDependencies(resolvedOptions);

  // Setup environment variables (create a file if there isn't one)
  let envName = await getEnvFilename(resolvedPath, framework.possibleEnvFilenames());
  if (!envName) {
    envName = framework.possibleEnvFilenames()[0]!;
    const newEnvPath = pathModule.join(resolvedPath, framework.possibleEnvFilenames()[0]!);
    await fs.writeFile(newEnvPath, "");
  }
  await setApiKeyEnvironmentVariable(resolvedPath, envName, resolvedOptions.apiKey);
  await setApiUrlEnvironmentVariable(resolvedPath, envName, resolvedOptions.apiUrl);
  await setPublicApiKeyEnvironmentVariable(
    resolvedPath,
    envName,
    framework.publicKeyEnvName,
    authorizedKey.pkApiKey
  );

  const installOptions = {
    typescript: isTypescriptProject,
    packageManager,
    endpointSlug: resolvedOptions.endpointSlug,
  };

  telemetryClient.init.install(resolvedOptions, framework.name, installOptions);
  await framework.install(resolvedPath, installOptions);

  telemetryClient.init.postInstall(resolvedOptions, framework.name, installOptions);
  await framework.postInstall(resolvedPath, installOptions);

  await addConfigurationToPackageJson(resolvedPath, resolvedOptions);

  const projectUrl = `${resolvedOptions.triggerUrl}/orgs/${authorizedKey.organization.slug}/projects/${authorizedKey.project.slug}`;
  if (framework.printInstallationComplete) {
    await framework.printInstallationComplete(projectUrl);
  } else {
    await printNextSteps(projectUrl, packageManager, framework);
  }
  telemetryClient.init.completed(resolvedOptions);
};

async function printNextSteps(
  projectUrl: string,
  packageManager: PackageManager,
  framework: Framework
) {
  logger.success(`✔ Successfully initialized Trigger.dev!`);
  logger.warn(
    `⚠️ Warning: We don't currently support long-running servers! For more details, check out https://github.com/triggerdotdev/trigger.dev/issues/244.`
  );
  logger.info("Next steps:");
  logger.info(`   1. Run your ${framework.name} project locally with '${packageManager} run dev'`);
  logger.info(
    `   2. In a separate terminal, run 'npx @trigger.dev/cli@latest dev' to watch for changes and automatically register Trigger.dev jobs`
  );
  logger.info(`   3. View your jobs at ${projectUrl}`);

  logger.info(
    `🔗 Head over to our docs at https://trigger.dev/docs to learn more about how to create different kinds of jobs and add integrations.`
  );
}

async function addConfigurationToPackageJson(path: string, options: ResolvedOptions) {
  const pkgJson = await readPackageJson(path);

  if (!pkgJson) {
    throw new Error("Could not find package.json");
  }

  pkgJson["trigger.dev"] = {
    endpointId: options.endpointSlug,
  };

  // Write the updated package.json file
  const pkgJsonPath = pathModule.join(path, "package.json");
  await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2));

  logger.success(`✔ Wrote trigger.dev config to package.json`);
}

type OptionsAfterPrompts = Required<Omit<InitCommandOptions, "endpointSlug">> & {
  endpointSlug: InitCommandOptions["endpointSlug"];
};

const resolveOptionsWithPrompts = async (
  options: InitCommandOptions,
  path: string
): Promise<OptionsAfterPrompts> => {
  const resolvedOptions: InitCommandOptions = { ...options };

  try {
    if (!options.triggerUrl) {
      resolvedOptions.triggerUrl = await promptTriggerUrl();
    }

    if (resolvedOptions.triggerUrl === CLOUD_TRIGGER_URL) {
      resolvedOptions.apiUrl = CLOUD_API_URL;
    } else {
      resolvedOptions.apiUrl = resolvedOptions.triggerUrl;
    }

    telemetryClient.init.resolvedApiUrl(resolvedOptions.apiUrl, resolvedOptions);

    if (!options.apiKey) {
      resolvedOptions.apiKey = await promptApiKey(resolvedOptions.triggerUrl!);
    }
    telemetryClient.init.resolvedApiKey(resolvedOptions);

    if (!options.endpointSlug) {
      const packageJSONPath = pathModule.join(path, "package.json");
      const packageJSON = await readJSONFile(packageJSONPath);

      if (packageJSON && packageJSON["trigger.dev"] && packageJSON["trigger.dev"].endpointId) {
        resolvedOptions.endpointSlug = packageJSON["trigger.dev"].endpointId;
        telemetryClient.init.resolvedEndpointSlug(resolvedOptions);
      }
    }
  } catch (err) {
    // If the user is not calling the command from an interactive terminal, inquirer will throw an error with isTTYError = true
    // If this happens, we catch the error, tell the user what has happened, and then continue to run the program with a default trigger project
    // Otherwise we have to do some fancy namespace extension logic on the Error type which feels overkill for one line
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err instanceof Error && (err as any).isTTYError) {
      logger.warn(`'${COMMAND_NAME} init' needs an interactive terminal to provide options`);

      const { shouldContinue } = await inquirer.prompt<{
        shouldContinue: boolean;
      }>({
        name: "shouldContinue",
        type: "confirm",
        message: `Continue initializing your trigger.dev project?`,
        default: true,
      });

      if (!shouldContinue) {
        telemetryClient.init.failed("non_interactive_terminal", options);
        logger.info("Exiting...");
        throw err;
      }
    } else {
      telemetryClient.init.failed("unknown", options, err);
      throw err;
    }
  }

  return resolvedOptions as OptionsAfterPrompts;
};

// Detects if there are any uncommitted git changes at path
async function detectGitChanges(path: string): Promise<boolean> {
  const git = simpleGit(path);

  try {
    const isRepo = await git.checkIsRepo();

    if (isRepo) {
      // Check if there are uncommitted changes
      const status = await git.status();
      return status.files.length > 0;
    }
    return false;
  } catch (error) {
    return false;
  }
}

async function detectTypescriptProject(path: string): Promise<boolean> {
  // Checks for the presence of a tsconfig.json file
  try {
    await fs.access(pathModule.join(path, "tsconfig.json"));
    return true;
  } catch (error) {
    return false;
  }
}
