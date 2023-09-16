import fs from "fs/promises";
import pathModule from "path";
import { Framework } from "..";
import { templatesPath } from "../../paths";
import { InstallPackage } from "../../utils/addDependencies";
import { createFileFromTemplate } from "../../utils/createFileFromTemplate";
import { pathExists } from "../../utils/fileSystem";
import { PackageManager } from "../../utils/getUserPkgManager";
import { logger } from "../../utils/logger";
import { getPathAlias } from "../../utils/pathAlias";
import { readPackageJson } from "../../utils/readPackageJson";
import { removeFileExtension } from "../../utils/removeFileExtension";
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
      { name: "@trigger.dev/react", tag: "latest" },
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

    const nextJsDir = await detectPagesOrAppDir(path);
    const routeDir = pathModule.join(path, usesSrcDir ? "src" : "");
    const pathAlias = await getPathAlias({
      projectPath: path,
      isTypescriptProject: options.typescript,
      usesSrcDir,
    });

    if (nextJsDir === "pages") {
      await createTriggerPageRoute(routeDir, options.endpointSlug, options.typescript, pathAlias);
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
  return pathExists(pathModule.join(path, "next.config.js"));
}

export async function detectNextDependency(path: string): Promise<boolean> {
  const packageJsonContent = await readPackageJson(path);
  if (!packageJsonContent) {
    return false;
  }

  return packageJsonContent.dependencies?.next !== undefined;
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

async function createTriggerPageRoute(
  path: string,
  endpointSlug: string,
  isTypescriptProject: boolean,
  pathAlias: string | undefined
) {
  const templatesDir = pathModule.join(templatesPath(), "nextjs");
  const fileExtension = isTypescriptProject ? ".ts" : ".js";

  //pages/api/trigger.js or src/pages/api/trigger.js
  const apiRoutePath = pathModule.join(path, "pages", "api", `trigger${fileExtension}`);
  const apiRouteResult = await createFileFromTemplate({
    templatePath: pathModule.join(templatesDir, "pagesApiRoute.js"),
    replacements: {
      routePathPrefix: pathAlias ? pathAlias + "/" : "../../",
    },
    outputPath: apiRoutePath,
  });
  if (!apiRouteResult.success) {
    throw new Error("Failed to create API route file");
  }
  logger.success(`✅ Created API route at ${apiRoutePath}`);

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
  logger.success(`✅ Created Trigger client at ${triggerFilePath}`);

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
  logger.success(`✅ Created example job at ${exampleJobFilePath}`);

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
  logger.success(`✅ Created jobs index at ${jobsIndexFilePath}`);
}

async function createTriggerAppRoute(
  projectPath: string,
  path: string,
  endpointSlug: string,
  isTypescriptProject: boolean,
  usesSrcDir = false
) {
  const pathAlias = getPathAlias({ projectPath, isTypescriptProject, usesSrcDir });

  const extension = isTypescriptProject ? ".ts" : ".js";
  const triggerFileName = `trigger${extension}`;
  const examplesFileName = `examples${extension}`;
  const examplesIndexFileName = `index${extension}`;
  const routeFileName = `route${extension}`;

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
