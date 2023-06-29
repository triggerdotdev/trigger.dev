#!/usr/bin/env node

import fs from "fs/promises";
import inquirer from "inquirer";
import pathModule from "path";
import { pathToRegexp } from "path-to-regexp";
import { simpleGit } from "simple-git";
import {
  promptApiKey,
  promptEndpointSlug,
  promptTriggerUrl,
} from "../cli/index.js";
import { COMMAND_NAME, DEFAULT_TRIGGER_URL } from "../consts.js";
import { addDependencies } from "../utils/addDependencies.js";
import { logger } from "../utils/logger.js";
import { resolvePath } from "../utils/parseNameAndPath.js";
import { renderApiKey } from "../utils/renderApiKey.js";
import { renderTitle } from "../utils/renderTitle.js";
import { detectNextJsProject } from "../utils/detectNextJsProject.js";

export type InitCommandOptions = {
  projectPath: string;
  triggerUrl?: string;
  endpointSlug?: string;
  apiKey?: string;
};

type ResolvedOptions = Required<InitCommandOptions>;

export const initCommand = async (options: InitCommandOptions) => {
  renderTitle();

  if (options.triggerUrl === DEFAULT_TRIGGER_URL) {
    logger.info(`✨ Initializing project in Trigger.dev Cloud`);
  } else if (typeof options.triggerUrl === "string") {
    logger.info(
      `✨ Initializing project using Trigger.dev at ${options.triggerUrl}`
    );
  } else {
    logger.info(`✨ Initializing Trigger.dev in project`);
  }

  const resolvedPath = resolvePath(options.projectPath);
  // Detect if are are in a Next.js project
  const isNextJsProject = await detectNextJsProject(resolvedPath);

  if (!isNextJsProject) {
    logger.error("You must run this command in a Next.js project.");
    process.exit(1);
  } else {
    logger.success("✅ Detected Next.js project");
  }

  const hasGitChanges = await detectGitChanges(resolvedPath);

  if (hasGitChanges) {
    // Warn the user that they have git changes
    logger.warn(
      "⚠️ You have uncommitted git changes, you may want to commit them before continuing."
    );
  }

  const isTypescriptProject = await detectTypescriptProject(resolvedPath);

  if (!isTypescriptProject) {
    // Exit with an error message
    logger.error(
      "You must be using TypeScript in your Next.js project to use Trigger.dev."
    );

    process.exit(1);
  }

  const resolvedOptions = await resolveOptionsWithPrompts(
    options,
    resolvedPath
  );

  const apiKey = resolvedOptions.apiKey;

  if (!apiKey) {
    logger.error("You must provide an API key to continue.");
    process.exit(1);
  }

  await addDependencies(resolvedPath, [
    { name: "@trigger.dev/sdk", tag: "next" },
    { name: "@trigger.dev/nextjs", tag: "latest" },
  ]);

  // Setup environment variables
  await setupEnvironmentVariables(resolvedPath, resolvedOptions);

  const usesSrcDir = await detectUseOfSrcDir(resolvedPath);

  if (usesSrcDir) {
    logger.info("📁 Detected use of src directory");
  }

  const nextJsDir = await detectPagesOrAppDir(resolvedPath, usesSrcDir);

  const routeDir = pathModule.join(resolvedPath, usesSrcDir ? "src" : "");

  if (nextJsDir === "pages") {
    await createTriggerPageRoute(routeDir, resolvedOptions, usesSrcDir);
  } else {
    await createTriggerAppRoute(routeDir, resolvedOptions, usesSrcDir);
  }

  await detectMiddlewareUsage(resolvedPath, usesSrcDir);

  await addConfigurationToPackageJson(resolvedPath, resolvedOptions);

  await printNextSteps(resolvedOptions);

  process.exit(0);
};

async function printNextSteps(options: ResolvedOptions) {
  logger.success(`✅ Successfully initialized Trigger.dev!`);

  logger.info(
    `🔗 You can now connect to ${options.triggerUrl} and run jobs locally using the '@trigger.dev/cli dev' command`
  );
}

async function addConfigurationToPackageJson(
  path: string,
  options: ResolvedOptions
) {
  const pkgJsonPath = pathModule.join(path, "package.json");
  const pkgBuffer = await fs.readFile(pkgJsonPath);
  const pkgJson = JSON.parse(pkgBuffer.toString());

  pkgJson["trigger.dev"] = {
    endpointId: options.endpointSlug,
  };

  // Write the updated package.json file
  await fs.writeFile(pkgJsonPath, JSON.stringify(pkgJson, null, 2));

  logger.success(`✅ Wrote trigger.dev config to package.json`);
}

const resolveOptionsWithPrompts = async (
  options: InitCommandOptions,
  path: string
): Promise<ResolvedOptions> => {
  const resolvedOptions: InitCommandOptions = { ...options };

  try {
    if (!options.triggerUrl) {
      resolvedOptions.triggerUrl = await promptTriggerUrl();
    }

    if (!options.apiKey) {
      resolvedOptions.apiKey = await promptApiKey(resolvedOptions.triggerUrl!);
    }

    if (!options.endpointSlug) {
      resolvedOptions.endpointSlug = await promptEndpointSlug(path);
    }
  } catch (err) {
    // If the user is not calling the command from an interactive terminal, inquirer will throw an error with isTTYError = true
    // If this happens, we catch the error, tell the user what has happened, and then continue to run the program with a default trigger project
    // Otherwise we have to do some fancy namespace extension logic on the Error type which feels overkill for one line
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err instanceof Error && (err as any).isTTYError) {
      logger.warn(
        `'${COMMAND_NAME} init' needs an interactive terminal to provide options`
      );

      const { shouldContinue } = await inquirer.prompt<{
        shouldContinue: boolean;
      }>({
        name: "shouldContinue",
        type: "confirm",
        message: `Continue initializing your trigger.dev project?`,
        default: true,
      });

      if (!shouldContinue) {
        logger.info("Exiting...");
        process.exit(0);
      }
    } else {
      throw err;
    }
  }

  return resolvedOptions as ResolvedOptions;
};

// Detects if there are any uncommitted git changes at path
async function detectGitChanges(path: string): Promise<boolean> {
  const git = simpleGit(path);
  const status = await git.status();

  return status.files.length > 0;
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

async function detectUseOfSrcDir(path: string): Promise<boolean> {
  // Detects if the project is using a src directory
  try {
    await fs.access(pathModule.join(path, "src"));
    return true;
  } catch (error) {
    return false;
  }
}

// Detect the use of pages or app dir in the Next.js project
// Import the next.config.js file and check for experimental: { appDir: true }
async function detectPagesOrAppDir(
  path: string,
  usesSrcDir = false
): Promise<"pages" | "app"> {
  const nextConfigPath = pathModule.join(path, "next.config.js");
  const importedConfig = await import(nextConfigPath);

  if (importedConfig?.default?.experimental?.appDir) {
    return "app";
  } else {
    // We need to check if src/app/page.tsx exists
    // Or app/page.tsx exists
    // If so then we return app
    // If not return pages

    const appPagePath = pathModule.join(
      path,
      usesSrcDir ? "src" : "",
      "app",
      "page.tsx"
    );

    const appPageExists = await pathExists(appPagePath);

    if (appPageExists) {
      return "app";
    }

    return "pages";
  }
}

async function detectMiddlewareUsage(path: string, usesSrcDir = false) {
  const middlewarePath = pathModule.join(
    path,
    usesSrcDir ? "src" : "",
    "middleware.ts"
  );

  const middlewareExists = await pathExists(middlewarePath);

  if (!middlewareExists) {
    return;
  }

  const matcher = await getMiddlewareConfigMatcher(middlewarePath);

  if (!matcher || matcher.length === 0) {
    logger.warn(
      `⚠️ ⚠️ ⚠️  It looks like there might be conflicting Next.js middleware in ${pathModule.relative(
        process.cwd(),
        middlewarePath
      )} which can cause issues with Trigger.dev. Please see https://trigger.dev/docs/documentation/guides/platforms/nextjs#middleware`
    );

    return;
  }

  if (matcher.length === 0) {
    return;
  }

  if (typeof matcher === "string") {
    const matcherRegex = pathToRegexp(matcher);

    // Check to see if /api/trigger matches the regex, if it does, then we need to output a warning with a link to the docs to fix it
    if (matcherRegex.test("/api/trigger")) {
      logger.warn(
        `🚨 It looks like there might be conflicting Next.js middleware in ${pathModule.relative(
          process.cwd(),
          middlewarePath
        )} which will cause issues with Trigger.dev. Please see https://trigger.dev/docs/documentation/guides/platforms/nextjs#middleware`
      );
    }
  } else if (
    Array.isArray(matcher) &&
    matcher.every((m) => typeof m === "string")
  ) {
    const matcherRegexes = matcher.map((m) => pathToRegexp(m));

    if (matcherRegexes.some((r) => r.test("/api/trigger"))) {
      logger.warn(
        `🚨 It looks like there might be conflicting Next.js middleware in ${pathModule.relative(
          process.cwd(),
          middlewarePath
        )} which will cause issues with Trigger.dev. Please see https://trigger.dev/docs/documentation/guides/platforms/nextjs#middleware`
      );
    }
  }
}

async function getMiddlewareConfigMatcher(
  path: string
): Promise<Array<string>> {
  const fileContent = await fs.readFile(path, "utf-8");

  const regex = /matcher:\s*(\[.*\]|".*")/s;
  let match = regex.exec(fileContent);

  if (!match) {
    return [];
  }

  if (match.length < 2) {
    return [];
  }

  let matcherString: string = match[1] as string;

  // Handle array scenario
  if (matcherString.startsWith("[") && matcherString.endsWith("]")) {
    matcherString = matcherString.slice(1, -1); // Remove brackets
    const arrayRegex = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
    let arrayMatch;
    const matches: string[] = [];
    while ((arrayMatch = arrayRegex.exec(matcherString)) !== null) {
      matches.push((arrayMatch[1] as string).slice(1, -1)); // remove quotes
    }
    return matches;
  } else {
    // Handle single string scenario
    return [matcherString.slice(1, -1)]; // remove quotes
  }
}

async function createTriggerPageRoute(
  path: string,
  options: ResolvedOptions,
  usesSrcDir = false
) {
  const routeContent = `
import { Job, TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createPagesRoute } from "@trigger.dev/nextjs";

const { handler, config } = createPagesRoute(client);
export { config };

const client = new TriggerClient({
  id: "${options.endpointSlug}",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
});

new Job(client, {
  id: "example-job",
  name: "Example Job",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "example.event",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("Hello world!", { payload });

    return {
      message: "Hello world!",
    };
  },
});

export default handler;
  `;

  const directories = pathModule.join(path, "pages", "api");
  await fs.mkdir(directories, { recursive: true });

  // Don't overwrite the file if it already exists
  const exists = await pathExists(pathModule.join(directories, "trigger.ts"));

  if (exists) {
    logger.info("Skipping creation of pages route because it already exists");
    return;
  }

  await fs.writeFile(pathModule.join(directories, "trigger.ts"), routeContent);
  logger.success(
    `✅ Created pages route at ${usesSrcDir ? "src/" : ""}pages/api/trigger.ts`
  );
}

async function createTriggerAppRoute(
  path: string,
  options: ResolvedOptions,
  usesSrcDir = false
) {
  const routeContent = `
import { Job, TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createAppRoute } from "@trigger.dev/nextjs";

const client = new TriggerClient({
  id: "${options.endpointSlug}",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
});

new Job(client, {
  id: "example-job",
  name: "Example Job",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "example.event",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("Hello world!", { payload });

    return {
      message: "Hello world!",
    };
  },
});

export const { POST, dynamic } = createAppRoute(client);
  `;

  const directories = pathModule.join(path, "app", "api", "trigger");
  await fs.mkdir(directories, { recursive: true });

  const fileExists = await pathExists(pathModule.join(directories, "route.ts"));

  if (fileExists) {
    logger.info("Skipping creation of app route because it already exists");
    return;
  }

  await fs.writeFile(pathModule.join(directories, "route.ts"), routeContent);
  logger.success(
    `✅ Created app route at ${usesSrcDir ? "src/" : ""}app/api/trigger.ts`
  );
}

async function setupEnvironmentVariables(
  path: string,
  options: ResolvedOptions
) {
  if (options.apiKey) {
    await setupEnvironmentVariable(
      path,
      ".env.local",
      "TRIGGER_API_KEY",
      options.apiKey,
      true,
      renderApiKey
    );
  }

  if (options.triggerUrl) {
    await setupEnvironmentVariable(
      path,
      ".env.local",
      "TRIGGER_API_URL",
      options.triggerUrl,
      true
    );
  }
}

async function setupEnvironmentVariable(
  dir: string,
  fileName: string,
  variableName: string,
  value: string,
  replaceValue: boolean = true,
  renderer: (value: string) => string = (value) => value
) {
  const path = pathModule.join(dir, fileName);
  const envFileExists = await pathExists(path);

  if (!envFileExists) {
    await fs.writeFile(path, "");
  }

  const envFileContent = await fs.readFile(path, "utf-8");

  if (envFileContent.includes(variableName)) {
    if (!replaceValue) {
      logger.info(
        `☑ Skipping setting ${variableName}=${renderer(
          value
        )} because it already exists`
      );
      return;
    }
    // Update the existing value
    const updatedEnvFileContent = envFileContent.replace(
      new RegExp(`${variableName}=.*\\n`, "g"),
      `${variableName}=${value}\n`
    );

    await fs.writeFile(path, updatedEnvFileContent);

    logger.success(`✅ Set ${variableName}=${renderer(value)} in ${fileName}`);
  } else {
    await fs.appendFile(path, `\n${variableName}=${value}`);

    logger.success(
      `✅ Added ${variableName}=${renderer(value)} to ${fileName}`
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    return false;
  }
}
