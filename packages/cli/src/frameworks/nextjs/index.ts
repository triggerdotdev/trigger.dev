import { pathToFileURL } from "url";
import { Framework } from "..";
import { InstallPackage } from "../../utils/addDependencies";
import { PackageManager } from "../../utils/getUserPkgManager";
import fs from "fs/promises";
import pathModule from "path";
import { readPackageJson } from "../../utils/readPackageJson";
import { logger } from "../../utils/logger";
import { pathExists } from "../../utils/fileSystem";
import { parse } from "tsconfck";
import { detectMiddlewareUsage } from "./middleware";

export class NextJs implements Framework {
  id = "nextjs";
  name = "Next.js";
  defaultHostname = "localhost";

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
    ];
  }

  possibleEnvFilenames(): string[] {
    return [".env.local", ".env"];
  }

  async install(
    path: string,
    options: { typescript: boolean; packageManager: PackageManager; endpointSlug: string }
  ): Promise<void> {
    const usesSrcDir = await detectUseOfSrcDir(path);
    if (usesSrcDir) {
      logger.info("📁 Detected use of src directory");
    }

    const nextJsDir = await detectPagesOrAppDir(path, usesSrcDir);

    const routeDir = pathModule.join(path, usesSrcDir ? "src" : "");

    if (nextJsDir === "pages") {
      await createTriggerPageRoute(
        path,
        routeDir,
        options.endpointSlug,
        options.typescript,
        usesSrcDir
      );
    } else {
      await createTriggerAppRoute(
        path,
        routeDir,
        options.endpointSlug,
        options.typescript,
        usesSrcDir
      );
    }
  }

  async postInstall(
    path: string,
    options: { typescript: boolean; packageManager: PackageManager; endpointSlug: string }
  ): Promise<void> {
    await detectMiddlewareUsage(path);
  }
}

async function detectNextConfigFile(path: string): Promise<boolean> {
  return fs
    .access(pathModule.join(path, "next.config.js"))
    .then(() => true)
    .catch(() => false);
}

async function detectNextDependency(path: string): Promise<boolean> {
  const packageJsonContent = await readPackageJson(path);
  if (!packageJsonContent) {
    return false;
  }

  return packageJsonContent.dependencies?.next !== undefined;
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
async function detectPagesOrAppDir(path: string, usesSrcDir = false): Promise<"pages" | "app"> {
  const nextConfigPath = pathModule.join(path, "next.config.js");
  const importedConfig = await import(pathToFileURL(nextConfigPath).toString()).catch(() => ({}));

  if (importedConfig?.default?.experimental?.appDir) {
    return "app";
  }

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

async function createTriggerPageRoute(
  projectPath: string,
  path: string,
  endpointSlug: string,
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
  id: "${endpointSlug}",
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

async function createTriggerAppRoute(
  projectPath: string,
  path: string,
  endpointSlug: string,
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
  id: "${endpointSlug}",
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

    logger.success(`✅ Created example job at ${usesSrcDir ? "src/" : ""}jobs/examples.ts`);
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
