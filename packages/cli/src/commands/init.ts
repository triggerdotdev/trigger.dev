#!/usr/bin/env node

import fs from "fs/promises";
import inquirer from "inquirer";
import pathModule from "path";
import { pathToRegexp } from "path-to-regexp";
import { simpleGit } from "simple-git";
import { parse } from "tsconfck";
import { pathToFileURL } from "url";
import { promptApiKey, promptTriggerUrl } from "../cli/index";
import { CLOUD_API_URL, CLOUD_TRIGGER_URL, COMMAND_NAME } from "../consts";
import { TelemetryClient, telemetryClient } from "../telemetry/telemetry";
import { addDependencies } from "../utils/addDependencies";
import { detectNextJsProject } from "../utils/detectNextJsProject";
import { pathExists, readJSONFile } from "../utils/fileSystem";
import { logger } from "../utils/logger";
import { resolvePath } from "../utils/parseNameAndPath";
import { renderApiKey } from "../utils/renderApiKey";
import { renderTitle } from "../utils/renderTitle";
import { TriggerApi, WhoamiResponse } from "../utils/triggerApi";

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

  await renderTitle(resolvedPath);

  if (options.triggerUrl === CLOUD_TRIGGER_URL) {
    logger.info(`✨ Initializing project in Trigger.dev Cloud`);
  } else if (typeof options.triggerUrl === "string") {
    logger.info(`✨ Initializing project using Trigger.dev at ${options.triggerUrl}`);
  } else {
    logger.info(`✨ Initializing Trigger.dev in project`);
  }

  // Detect if are are in a Next.js project
  const isNextJsProject = await detectNextJsProject(resolvedPath);

  if (!isNextJsProject) {
    logger.error("You must run this command in a Next.js project.");
    telemetryClient.init.failed("not_nextjs_project", options);
    return;
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
  telemetryClient.init.isTypescriptProject(isTypescriptProject, options);

  const optionsAfterPrompts = await resolveOptionsWithPrompts(
    options,
    resolvedPath,
    telemetryClient
  );
  const apiKey = optionsAfterPrompts.apiKey;

  if (!apiKey) {
    logger.error("You must provide an API key to continue.");
    telemetryClient.init.failed("no_api_key", optionsAfterPrompts);
    return;
  }

  const apiClient = new TriggerApi(apiKey, optionsAfterPrompts.apiUrl);
  const authorizedKey = await apiClient.whoami(apiKey);

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

  await addDependencies(resolvedPath, [
    { name: "@trigger.dev/sdk", tag: "latest" },
    { name: "@trigger.dev/nextjs", tag: "latest" },
  ]);

  telemetryClient.init.addedDependencies(resolvedOptions);

  // Setup environment variables
  await setupEnvironmentVariables(resolvedPath, resolvedOptions);

  const usesSrcDir = await detectUseOfSrcDir(resolvedPath);

  if (usesSrcDir) {
    logger.info("📁 Detected use of src directory");
  }

  const nextJsDir = await detectPagesOrAppDir(resolvedPath, usesSrcDir);

  const routeDir = pathModule.join(resolvedPath, usesSrcDir ? "src" : "");

  if (nextJsDir === "pages") {
    telemetryClient.init.createFiles(resolvedOptions, "pages");
    await createTriggerPageRoute(
      resolvedPath,
      routeDir,
      resolvedOptions,
      isTypescriptProject,
      usesSrcDir
    );
  } else {
    telemetryClient.init.createFiles(resolvedOptions, "app");
    await createTriggerAppRoute(
      resolvedPath,
      routeDir,
      resolvedOptions,
      isTypescriptProject,
      usesSrcDir
    );
  }

  await detectMiddlewareUsage(resolvedPath, usesSrcDir);

  await addConfigurationToPackageJson(resolvedPath, resolvedOptions);

  await printNextSteps(resolvedOptions, authorizedKey);
  telemetryClient.init.completed(resolvedOptions);
};

async function printNextSteps(options: ResolvedOptions, authorizedKey: WhoamiResponse) {
  const projectUrl = `${options.triggerUrl}/orgs/${authorizedKey.organization.slug}/projects/${authorizedKey.project.slug}`;

  logger.success(`✅ Successfully initialized Trigger.dev!`);

  logger.info("Next steps:");
  logger.info(`   1. Run your Next.js project locally with 'npm run dev'`);
  logger.info(
    `   2. In a separate terminal, run 'npx @trigger.dev/cli@latest dev' to watch for changes and automatically register Trigger.dev jobs`
  );
  logger.info(`   3. View your jobs at ${projectUrl}`);

  logger.info(
    `🔗 Head over to our docs at https://trigger.dev/docs to learn more about how to create different kinds of jobs and add integrations.`
  );
}

async function addConfigurationToPackageJson(path: string, options: ResolvedOptions) {
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

type OptionsAfterPrompts = Required<Omit<InitCommandOptions, "endpointSlug">> & {
  endpointSlug: InitCommandOptions["endpointSlug"];
};

const resolveOptionsWithPrompts = async (
  options: InitCommandOptions,
  path: string,
  telemetryClient: TelemetryClient
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
  usesSrcDir = false,
): Promise<"pages" | "app"> {
  const nextConfigPath = pathModule.join(path, "next.config.js");
  const importedConfig = await import(pathToFileURL(nextConfigPath).toString()).catch(() => ({}));

  if (importedConfig?.default?.experimental?.appDir) {
    return "app";
  } else {
    // We need to check if src/app/page.tsx exists
    // Or app/page.tsx exists
    // If so then we return app
    // If not return pages

    const extensionsToCheck = ["jsx", "tsx", "js", "ts"];
    const basePath = pathModule.join(path, usesSrcDir ? "src" : "", "app", `page.`);

    for (const extension of extensionsToCheck) {
      const appPagePath = basePath + extension;
      const appPageExists = await pathExists(appPagePath);

      if (appPageExists) {
        return "app";
      }
    }

    return "pages";
  }
}

async function detectMiddlewareUsage(path: string, usesSrcDir = false) {
  const middlewarePath = pathModule.join(path, usesSrcDir ? "src" : "", "middleware.ts");

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

    telemetryClient.init.warning("middleware_conflict", { projectPath: path });
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
      telemetryClient.init.warning("middleware_conflict_api_trigger", { projectPath: path });
    }
  } else if (Array.isArray(matcher) && matcher.every((m) => typeof m === "string")) {
    const matcherRegexes = matcher.map((m) => pathToRegexp(m));

    if (matcherRegexes.some((r) => r.test("/api/trigger"))) {
      logger.warn(
        `🚨 It looks like there might be conflicting Next.js middleware in ${pathModule.relative(
          process.cwd(),
          middlewarePath
        )} which will cause issues with Trigger.dev. Please see https://trigger.dev/docs/documentation/guides/platforms/nextjs#middleware`
      );
      telemetryClient.init.warning("middleware_conflict", { projectPath: path });
    }
  }
}

async function getMiddlewareConfigMatcher(path: string): Promise<Array<string>> {
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

// Find the alias that points to the "src" directory.
// So for example, the paths object could be:
// {
//   "@/*": ["./src/*"]
// }
// In this case, we would return "@"
function getPathAlias(tsconfig: any, usesSrcDir: boolean) {
  if (!tsconfig.compilerOptions.paths) {
    return;
  }

  const paths = tsconfig.compilerOptions.paths;

  const alias = Object.keys(paths).find((key) => {
    const value = paths[key];

    if (value.length !== 1) {
      return false;
    }

    const path = value[0];

    if (usesSrcDir) {
      return path === "./src/*";
    } else {
      return path === "./*";
    }
  });

  // Make sure to remove the trailing "/*"
  if (alias) {
    return alias.slice(0, -2);
  }

  return;
}

async function createTriggerAppRoute(
  projectPath: string,
  path: string,
  options: ResolvedOptions,
  isTypescriptProject: boolean,
  usesSrcDir = false
) {
  const configFileName = isTypescriptProject ? "tsconfig.json" : "jsconfig.json";
  const tsConfigPath = pathModule.join(projectPath, configFileName);
  const { tsconfig } = await parse(tsConfigPath);

  const extension = isTypescriptProject ? ".ts" : ".js";
  const triggerFileName = `trigger${extension}`;
  const examplesFileName = `examples${extension}`;
  const examplesIndexFileName = `index${extension}`;
  const routeFileName = `route${extension}`;

  const pathAlias = getPathAlias(tsconfig, usesSrcDir);
  const routePathPrefix = pathAlias ? pathAlias + "/" : "../../../";

  const routeContent = `
import { createAppRoute } from "@trigger.dev/nextjs";
import { client } from "${routePathPrefix}trigger";


import "${routePathPrefix}jobs";

//this route is used to send and receive data with Trigger.dev
export const { POST, dynamic } = createAppRoute(client);
`;

  const triggerContent = `
import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "${options.endpointSlug}",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
});
  `;

  const jobsPathPrefix = pathAlias ? pathAlias + "/" : "../";

  const jobsContent = `
import { eventTrigger } from "@trigger.dev/sdk";
import { client } from "${jobsPathPrefix}trigger";

// Your first job
// This Job will be triggered by an event, log a joke to the console, and then wait 5 seconds before logging the punchline
client.defineJob({
  // This is the unique identifier for your Job, it must be unique across all Jobs in your project
  id: "example-job",
  name: "Example Job: a joke with a delay",
  version: "0.0.1",
  // This is triggered by an event using eventTrigger. You can also trigger Jobs with webhooks, on schedules, and more: https://trigger.dev/docs/documentation/concepts/triggers/introduction
  trigger: eventTrigger({
    name: "example.event",
  }),
  run: async (payload, io, ctx) => {
    // This logs a message to the console
    await io.logger.info("🧪 Example Job: a joke with a delay");
    await io.logger.info("How do you comfort a JavaScript bug?");
    // This waits for 5 seconds, the second parameter is the number of seconds to wait, you can add delays of up to a year
    await io.wait("Wait 5 seconds for the punchline...", 5);
    await io.logger.info("You console it! 🤦");
    await io.logger.info(
      "✨ Congratulations, You just ran your first successful Trigger.dev Job! ✨"
    );
    // To learn how to write much more complex (and probably funnier) Jobs, check out our docs: https://trigger.dev/docs/documentation/guides/create-a-job
  },
});

`;

  const examplesIndexContent = `
// import all your job files here

export * from "./examples"
`;

  const directories = pathModule.join(path, "app", "api", "trigger");
  await fs.mkdir(directories, { recursive: true });

  const fileExists = await pathExists(pathModule.join(directories, routeFileName));

  if (fileExists) {
    logger.info("Skipping creation of app route because it already exists");
    return;
  }

  await fs.writeFile(pathModule.join(directories, routeFileName), routeContent);

  logger.success(
    `✅ Created app route at ${usesSrcDir ? "src/" : ""}app/api/${removeFileExtension(
      triggerFileName
    )}/${routeFileName}`
  );

  const triggerFileExists = await pathExists(pathModule.join(path, triggerFileName));

  if (!triggerFileExists) {
    await fs.writeFile(pathModule.join(path, triggerFileName), triggerContent);

    logger.success(`✅ Created trigger client at ${usesSrcDir ? "src/" : ""}${triggerFileName}`);
  }

  const exampleDirectories = pathModule.join(path, "jobs");
  await fs.mkdir(exampleDirectories, { recursive: true });

  const exampleFileExists = await pathExists(pathModule.join(exampleDirectories, examplesFileName));

  if (!exampleFileExists) {
    await fs.writeFile(pathModule.join(exampleDirectories, examplesFileName), jobsContent);

    await fs.writeFile(
      pathModule.join(exampleDirectories, examplesIndexFileName),
      examplesIndexContent
    );

    logger.success(
      `✅ Created example job at ${usesSrcDir ? "src/" : ""}jobs/examples/examplesFileName`
    );
  }
}

async function createTriggerPageRoute(
  projectPath: string,
  path: string,
  options: ResolvedOptions,
  isTypescriptProject: boolean,
  usesSrcDir = false
) {
  const configFileName = isTypescriptProject ? "tsconfig.json" : "jsconfig.json";
  const tsConfigPath = pathModule.join(projectPath, configFileName);
  const { tsconfig } = await parse(tsConfigPath);

  const pathAlias = getPathAlias(tsconfig, usesSrcDir);
  const routePathPrefix = pathAlias ? pathAlias + "/" : "../../";

  const extension = isTypescriptProject ? ".ts" : ".js";
  const triggerFileName = `trigger${extension}`;
  const examplesFileName = `examples${extension}`;
  const examplesIndexFileName = `index${extension}`;

  const routeContent = `
import { createPagesRoute } from "@trigger.dev/nextjs";
import { client } from "${routePathPrefix}trigger";

import "${routePathPrefix}jobs";

//this route is used to send and receive data with Trigger.dev
const { handler, config } = createPagesRoute(client);
export { config };

export default handler;
  `;

  const triggerContent = `
import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "${options.endpointSlug}",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
});
  `;

  const jobsPathPrefix = pathAlias ? pathAlias + "/" : "../";

  const jobsContent = `
import { eventTrigger } from "@trigger.dev/sdk";
import { client } from "${jobsPathPrefix}trigger";

// Your first job
// This Job will be triggered by an event, log a joke to the console, and then wait 5 seconds before logging the punchline
client.defineJob({
  // This is the unique identifier for your Job, it must be unique across all Jobs in your project
  id: "example-job",
  name: "Example Job: a joke with a delay",
  version: "0.0.1",
  // This is triggered by an event using eventTrigger. You can also trigger Jobs with webhooks, on schedules, and more: https://trigger.dev/docs/documentation/concepts/triggers/introduction
  trigger: eventTrigger({
    name: "example.event",
  }),
  run: async (payload, io, ctx) => {
    // This logs a message to the console
    await io.logger.info("🧪 Example Job: a joke with a delay");
    await io.logger.info("How do you comfort a JavaScript bug?");
    // This waits for 5 seconds, the second parameter is the number of seconds to wait, you can add delays of up to a year
    await io.wait("Wait 5 seconds for the punchline...", 5);
    await io.logger.info("You console it! 🤦");
    await io.logger.info(
      "✨ Congratulations, You just ran your first successful Trigger.dev Job! ✨"
    );
    // To learn how to write much more complex (and probably funnier) Jobs, check out our docs: https://trigger.dev/docs/documentation/guides/create-a-job
  },
});
`;

  const examplesIndexContent = `
// import all your job files here

export * from "./examples"
  `;

  const directories = pathModule.join(path, "pages", "api");
  await fs.mkdir(directories, { recursive: true });

  // Don't overwrite the file if it already exists
  const exists = await pathExists(pathModule.join(directories, triggerFileName));

  if (exists) {
    logger.info("Skipping creation of pages route because it already exists");
    return;
  }

  await fs.writeFile(pathModule.join(directories, triggerFileName), routeContent);
  logger.success(
    `✅ Created pages route at ${usesSrcDir ? "src/" : ""}pages/api/${triggerFileName}`
  );

  const triggerFileExists = await pathExists(pathModule.join(path, triggerFileName));

  if (!triggerFileExists) {
    await fs.writeFile(pathModule.join(path, triggerFileName), triggerContent);

    logger.success(`✅ Created TriggerClient at ${usesSrcDir ? "src/" : ""}${triggerFileName}`);
  }

  const exampleDirectories = pathModule.join(path, "jobs");
  await fs.mkdir(exampleDirectories, { recursive: true });

  const exampleFileExists = await pathExists(pathModule.join(exampleDirectories, examplesFileName));

  if (!exampleFileExists) {
    await fs.writeFile(pathModule.join(exampleDirectories, examplesFileName), jobsContent);

    await fs.writeFile(
      pathModule.join(exampleDirectories, examplesIndexFileName),
      examplesIndexContent
    );

    logger.success(
      `✅ Created example job at ${usesSrcDir ? "src/" : ""}jobs/examples/${examplesFileName}`
    );
  }
}

async function setupEnvironmentVariables(path: string, options: ResolvedOptions) {
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
    await setupEnvironmentVariable(path, ".env.local", "TRIGGER_API_URL", options.triggerUrl, true);
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
        `☑ Skipping setting ${variableName}=${renderer(value)} because it already exists`
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

    logger.success(`✅ Added ${variableName}=${renderer(value)} to ${fileName}`);
  }
}

function removeFileExtension(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}
