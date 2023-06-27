#!/usr/bin/env node

import { CliResults, parseCliOptions, runCliPrompts } from "./cli/index.js";
import { addDependencies } from "./utils/addDependencies.js";
import { logger } from "./utils/logger.js";
import { resolvePath } from "./utils/parseNameAndPath.js";
import { renderTitle } from "./utils/renderTitle.js";
import fs from "fs/promises";
import pathModule from "path";
import { simpleGit } from "simple-git";
import { TriggerApi } from "./utils/triggerApi.js";
import { DEFAULT_TRIGGER_URL } from "./consts.js";
import ora from "ora";

const main = async () => {
  renderTitle();

  const cliOptions = await parseCliOptions();

  if (cliOptions.flags.triggerUrl === DEFAULT_TRIGGER_URL) {
    logger.info(`✨ Initializing project in Trigger.dev Cloud`);
  } else if (typeof cliOptions.flags.triggerUrl === "string") {
    logger.info(
      `✨ Initializing project using Trigger.dev at ${cliOptions.flags.triggerUrl}`
    );
  } else {
    logger.info(`✨ Initializing Trigger.dev in project`);
  }

  const resolvedPath = resolvePath(cliOptions.flags.projectPath);
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

  const cliResults = await runCliPrompts(cliOptions);

  const apiKey = cliResults.flags.apiKey;

  if (!apiKey) {
    logger.error("You must provide an API key to continue.");
    process.exit(1);
  }

  await addDependencies(resolvedPath, [
    { name: "@trigger.dev/sdk", version: "next" },
    { name: "@trigger.dev/nextjs", version: "latest" },
  ]);

  // Setup environment variables
  await setupEnvironmentVariables(resolvedPath, cliResults);

  const usesSrcDir = await detectUseOfSrcDir(resolvedPath);

  if (usesSrcDir) {
    logger.info("📁 Detected use of src directory");
  }

  const nextJsDir = await detectPagesOrAppDir(resolvedPath, usesSrcDir);

  const routeDir = pathModule.join(resolvedPath, usesSrcDir ? "src" : "");

  if (nextJsDir === "pages") {
    await createTriggerPageRoute(routeDir, cliResults, usesSrcDir);
  } else {
    await createTriggerAppRoute(routeDir, cliResults, usesSrcDir);
  }

  await waitForProjectToBuild();

  const api = new TriggerApi(apiKey, cliResults.flags.triggerUrl);

  const endpoint = await api.createEndpoint({
    id: cliResults.flags.endpointSlug,
    url: `${cliResults.flags.endpointUrl}${
      cliResults.flags.endpointUrl.endsWith("/") ? "" : "/"
    }api/trigger`,
  });

  if (!endpoint) {
    logger.error(
      "Unable to create endpoint, please contact eric@trigger.dev for assistance."
    );

    process.exit(1);
  }

  logger.success(`✅ Successfully initialized Trigger.dev!`);
  logger.info(
    `🔗 Visit your Trigger.dev dashboard at ${cliResults.flags.triggerUrl}`
  );

  process.exit(0);
};

main().catch((err) => {
  logger.error("Aborting installation...");
  if (err instanceof Error) {
    logger.error(err);
  } else {
    logger.error(
      "An unknown error has occurred. Please open an issue on github with the below:"
    );
    console.log(err);
  }
  process.exit(1);
});

// Detects if the project is a Next.js project at path
async function detectNextJsProject(path: string): Promise<boolean> {
  // Checks for the presence of a next.config.js file
  try {
    // Check if next.config.js file exists in the given path
    await fs.access(pathModule.join(path, "next.config.js"));
    return true;
  } catch (error) {
    // If next.config.js file doesn't exist, it's not a Next.js project
    return false;
  }
}

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

async function createTriggerPageRoute(
  path: string,
  cliResults: CliResults,
  usesSrcDir = false
) {
  const routeContent = `
import { Job, TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createPagesRoute } from "@trigger.dev/nextjs";

const { handler, config } = createPagesRoute(client, { path: "/api/trigger" });
export { config };

const client = new TriggerClient({
  id: "${cliResults.flags.endpointSlug}",
  url: process.env.VERCEL_URL,
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
  cliResults: CliResults,
  usesSrcDir = false
) {
  const routeContent = `
import { Job, TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createAppRoute } from "@trigger.dev/nextjs";

const client = new TriggerClient({
  id: "${cliResults.flags.endpointSlug}",
  url: process.env.VERCEL_URL,
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

export const { POST, dynamic } = createAppRoute(client, {
  path: "/api/trigger",
});
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

async function setupEnvironmentVariables(path: string, cliResults: CliResults) {
  const envFilePath = pathModule.join(path, ".env.local");
  const envFileExists = await pathExists(envFilePath);

  if (envFileExists) {
    const envFileContent = await fs.readFile(envFilePath, "utf-8");

    if (envFileContent.includes("TRIGGER_API_KEY")) {
      // Update the existing value
      const updatedEnvFileContent = envFileContent.replace(
        /TRIGGER_API_KEY=.*/g,
        `TRIGGER_API_KEY=${cliResults.flags.apiKey}`
      );

      await fs.writeFile(envFilePath, updatedEnvFileContent);

      logger.success("✅ Updated TRIGGER_API_KEY in .env.local");
    } else {
      await fs.appendFile(
        envFilePath,
        `TRIGGER_API_KEY=${cliResults.flags.apiKey}\n`
      );

      logger.success("✅ Added TRIGGER_API_KEY to .env.local");
    }

    if (envFileContent.includes("TRIGGER_API_URL")) {
      // Update existing value
      const updatedEnvFileContent = envFileContent.replace(
        /TRIGGER_API_URL=.*/g,
        `TRIGGER_API_URL=${cliResults.flags.triggerUrl}`
      );

      await fs.writeFile(envFilePath, updatedEnvFileContent);

      logger.success("✅ Updated TRIGGER_API_URL in .env.local");
    } else {
      await fs.appendFile(
        envFilePath,
        `TRIGGER_API_URL=${cliResults.flags.triggerUrl}\n`
      );

      logger.success("✅ Added TRIGGER_API_URL to .env.local");
    }

    if (!envFileContent.includes("VERCEL_URL")) {
      await fs.appendFile(
        envFilePath,
        `VERCEL_URL=${cliResults.flags.endpointUrl}\n`
      );

      logger.success("✅ Added VERCEL_URL to .env.local");
    }
  } else {
    const envFileContent = `
TRIGGER_API_KEY=${cliResults.flags.apiKey}
TRIGGER_API_URL=${cliResults.flags.triggerUrl}
VERCEL_URL=${cliResults.flags.endpointUrl}
  `;

    await fs.writeFile(envFilePath, envFileContent);

    logger.success(
      "✅ Created .env.local and added required environment variables"
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

async function waitForProjectToBuild() {
  const spinner = ora("Waiting for project to build...").start();

  await new Promise((resolve) => {
    setTimeout(resolve, 1000);
  });

  spinner.stop();
}
