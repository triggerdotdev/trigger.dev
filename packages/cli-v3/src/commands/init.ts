import { intro, isCancel, log, outro, select, spinner, text } from "@clack/prompts";
import { context, trace } from "@opentelemetry/api";
import {
  GetProjectResponseBody,
  flattenAttributes,
  recordSpanException,
} from "@trigger.dev/core/v3";
import { Command } from "commander";
import { join, relative, resolve } from "node:path";
import terminalLink from "terminal-link";
import { z } from "zod";
import { CliApiClient } from "../apiClient";
import {
  CommonCommandOptions,
  OutroCommandError,
  SkipCommandError,
  SkipLoggingError,
  commonOptions,
  handleTelemetry,
  tracer,
  wrapCommandAction,
} from "../cli/common.js";
import { readConfig } from "../utilities/configFiles.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger";
import { login } from "./login";
import { resolveInternalFilePath } from "../utilities/resolveInternalFilePath";
import { createFileFromTemplate } from "../utilities/createFileFromTemplate";
import { getUserPackageManager } from "../utilities/getUserPackageManager";
import { execa } from "execa";
import { createFile, isDirectory, pathExists } from "../utilities/fileSystem";
import chalk from "chalk";

const InitCommandOptions = CommonCommandOptions.extend({
  projectRef: z.string().optional(),
  overrideConfig: z.boolean().default(false),
  tag: z.string().default("latest"),
  skipPackageInstall: z.boolean().default(false),
});

type InitCommandOptions = z.infer<typeof InitCommandOptions>;

export function configureInitCommand(program: Command) {
  return commonOptions(
    program
      .command("init")
      .description("Initialize your existing project for development with Trigger.dev")
      .argument("[path]", "The path to the project", ".")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref to use when initializing the project"
      )
      .option(
        "-p, --project-ref <project ref>",
        "The project ref to use when initializing the project"
      )
      .option(
        "-t, --tag <package tag>",
        "The version of the @trigger.dev/sdk package to install",
        "latest"
      )
      .option("--skip-package-install", "Skip installing the @trigger.dev/sdk package")
      .option("--override-config", "Override the existing config file if it exists")
  ).action(async (path, options) => {
    await handleTelemetry(async () => {
      await printStandloneInitialBanner(true);
      await initCommand(path, options);
    });
  });
}

export async function initCommand(dir: string, options: unknown) {
  return await wrapCommandAction("initCommand", InitCommandOptions, options, async (opts) => {
    return await _initCommand(dir, opts);
  });
}

async function _initCommand(dir: string, options: InitCommandOptions) {
  const span = trace.getSpan(context.active());

  intro("Initializing project");

  const authorization = await login({ embedded: true, defaultApiUrl: options.apiUrl });

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      throw new Error(
        `Failed to connect to ${authorization.auth?.apiUrl}. Are you sure it's the correct URL?`
      );
    } else {
      throw new Error("You must login first. Use `trigger.dev login` to login.");
    }
  }

  span?.setAttributes({
    "cli.userId": authorization.userId,
    "cli.email": authorization.email,
    "cli.config.apiUrl": authorization.auth.apiUrl,
  });

  if (!options.overrideConfig) {
    try {
      // check to see if there is an existing trigger.dev config file in the project directory
      const result = await readConfig(dir);

      outro(
        result.status === "file"
          ? `Project already initialized: Found config file at ${result.path}. Pass --override-config to override`
          : "Project already initialized"
      );

      return;
    } catch (e) {
      // continue
    }
  }

  const apiClient = new CliApiClient(authorization.auth.apiUrl, authorization.auth.accessToken);

  const selectedProject = await selectProject(
    apiClient,
    authorization.dashboardUrl,
    options.projectRef
  );

  span?.setAttributes({
    ...flattenAttributes(selectedProject, "cli.project"),
  });

  logger.debug("Selected project", selectedProject);

  log.step(`Configuring project "${selectedProject.name}" (${selectedProject.externalRef})`);

  // Install @trigger.dev/sdk package
  if (!options.skipPackageInstall) {
    await installPackages(dir, options);
  } else {
    log.info("Skipping package installation");
  }

  // Create the config file
  await writeConfigFile(dir, selectedProject, options);

  // Create the trigger dir
  await createTriggerDir(dir, options);

  const projectDashboard = terminalLink(
    "project dashboard",
    `${authorization.dashboardUrl}/projects/${selectedProject.externalRef}`
  );

  log.success("Successfully initialized project for Trigger.dev v3 🫡");
  log.info("Next steps:");
  log.info(
    `   1. To start developing, run ${chalk.green(
      "npx trigger.dev@latest dev"
    )} in your project directory`
  );
  log.info(`   2. Visit your ${projectDashboard} to view your newly created tasks.`);
  log.info(`   3. Head over to our v3 docs at https://trigger.dev/docs/v3 to learn more.`);

  outro(`Project initialized successfully. Happy coding!`);
}

async function createTriggerDir(dir: string, options: InitCommandOptions) {
  return await tracer.startActiveSpan("createTriggerDir", async (span) => {
    try {
      const location = await text({
        message: "Where would you like to create the Trigger.dev directory?",
        defaultValue: `${dir}/src/trigger`,
        placeholder: `${dir}/src/trigger`,
      });

      if (isCancel(location)) {
        throw new OutroCommandError();
      }

      const triggerDir = resolve(process.cwd(), location);

      span.setAttributes({
        "cli.triggerDir": triggerDir,
      });

      if (await pathExists(triggerDir)) {
        throw new Error(`Directory already exists at ${triggerDir}`);
      }

      const exampleSelection = await select({
        message: `Choose an example to create in the ${location} directory`,
        options: [
          { value: "simple", label: "Simple (Hello World)" },
          {
            value: "none",
            label: "None",
            hint: "skip creating an example",
          },
        ],
      });

      if (isCancel(exampleSelection)) {
        throw new OutroCommandError();
      }

      const example = exampleSelection as string;

      span.setAttributes({
        "cli.example": example,
      });

      if (example === "none") {
        // Create a .gitkeep file in the trigger dir
        await createFile(join(triggerDir, ".gitkeep"), "");

        log.step(`Created directory at ${location}`);

        span.end();
        return;
      }

      const exampleFile = resolveInternalFilePath(`./templates/examples/${example}.js`);
      const outputPath = join(triggerDir, "example.ts");

      await createFileFromTemplate({
        templatePath: exampleFile,
        outputPath,
        replacements: {},
      });

      const relativeOutputPath = relative(process.cwd(), outputPath);

      log.step(`Created example file at ${relativeOutputPath}`);

      span.end();
    } catch (e) {
      if (!(e instanceof SkipCommandError)) {
        recordSpanException(span, e);
      }

      span.end();

      throw e;
    }
  });
}

async function installPackages(dir: string, options: InitCommandOptions) {
  return await tracer.startActiveSpan("installPackages", async (span) => {
    const installSpinner = spinner();

    try {
      const projectDir = resolve(process.cwd(), dir);
      const pkgManager = await getUserPackageManager(projectDir);

      span.setAttributes({
        "cli.projectDir": projectDir,
        "cli.packageManager": pkgManager,
        "cli.tag": options.tag,
      });

      switch (pkgManager) {
        case "npm": {
          installSpinner.start(`Running npm install @trigger.dev/sdk@${options.tag}`);

          await execa("npm", ["install", `@trigger.dev/sdk@${options.tag}`], {
            cwd: projectDir,
            stdio: options.logLevel === "debug" ? "inherit" : "ignore",
          });

          break;
        }
        case "pnpm": {
          installSpinner.start(`Running pnpm add @trigger.dev/sdk@${options.tag}`);

          await execa("pnpm", ["add", `@trigger.dev/sdk@${options.tag}`], {
            cwd: projectDir,
            stdio: options.logLevel === "debug" ? "inherit" : "ignore",
          });

          break;
        }
        case "yarn": {
          installSpinner.start(`Running yarn add @trigger.dev/sdk@${options.tag}`);

          await execa("yarn", ["add", `@trigger.dev/sdk@${options.tag}`], {
            cwd: projectDir,
            stdio: options.logLevel === "debug" ? "inherit" : "ignore",
          });

          break;
        }
      }

      installSpinner.stop(`@trigger.dev/sdk@${options.tag} installed`);

      span.end();
    } catch (e) {
      installSpinner.stop(
        `Failed to install @trigger.dev/sdk@${options.tag}. Rerun command with --log-level debug for more details.`
      );

      if (!(e instanceof SkipCommandError)) {
        recordSpanException(span, e);
      }

      span.end();

      throw e;
    }
  });
}

async function writeConfigFile(
  dir: string,
  project: GetProjectResponseBody,
  options: InitCommandOptions
) {
  return await tracer.startActiveSpan("writeConfigFile", async (span) => {
    try {
      const spnnr = spinner();
      spnnr.start("Creating config file");

      const projectDir = resolve(process.cwd(), dir);
      const templatePath = resolveInternalFilePath("./templates/trigger.config.mjs");
      const outputPath = join(projectDir, "trigger.config.mjs");

      span.setAttributes({
        "cli.projectDir": projectDir,
        "cli.templatePath": templatePath,
        "cli.outputPath": outputPath,
      });

      const result = await createFileFromTemplate({
        templatePath,
        replacements: {
          projectRef: project.externalRef,
        },
        outputPath,
        override: options.overrideConfig,
      });

      const relativePathToOutput = relative(process.cwd(), outputPath);

      spnnr.stop(
        result.success
          ? `Config file created at ${relativePathToOutput}`
          : `Failed to create config file: ${result.error}`
      );

      if (!result.success) {
        throw new SkipLoggingError(result.error);
      }

      span.end();

      return result.success;
    } catch (e) {
      if (!(e instanceof SkipCommandError)) {
        recordSpanException(span, e);
      }

      span.end();

      throw e;
    }
  });
}

async function selectProject(apiClient: CliApiClient, dashboardUrl: string, projectRef?: string) {
  return await tracer.startActiveSpan("selectProject", async (span) => {
    try {
      if (projectRef) {
        const projectResponse = await apiClient.getProject(projectRef);

        if (!projectResponse.success) {
          log.error(
            `--project-ref ${projectRef} is not a valid project ref. Request to fetch data resulted in: ${projectResponse.error}`
          );

          throw new SkipCommandError(projectResponse.error);
        }

        span.setAttributes({
          ...flattenAttributes(projectResponse.data, "cli.project"),
        });

        span.end();

        return projectResponse.data;
      }

      const projectsResponse = await apiClient.getProjects();

      if (!projectsResponse.success) {
        throw new Error(`Failed to get projects: ${projectsResponse.error}`);
      }

      if (projectsResponse.data.length === 0) {
        const newProjectLink = terminalLink(
          "Create new project",
          `${dashboardUrl}/projects/new?version=v3`
        );

        outro(`You don't have any projects yet. ${newProjectLink}`);

        throw new SkipCommandError();
      }

      const selectedProject = await select({
        message: "Select an existing Trigger.dev project",
        options: projectsResponse.data.map((project) => ({
          value: project.externalRef,
          label: `${project.name} - ${project.externalRef}`,
          hint: project.organization.title,
        })),
      });

      if (isCancel(selectedProject)) {
        throw new OutroCommandError();
      }

      const projectData = projectsResponse.data.find(
        (project) => project.externalRef === selectedProject
      );

      if (!projectData) {
        throw new Error("Invalid project ref");
      }

      span.setAttributes({
        ...flattenAttributes(projectData, "cli.project"),
      });

      span.end();

      return projectData;
    } catch (e) {
      if (!(e instanceof SkipCommandError)) {
        recordSpanException(span, e);
      }

      span.end();

      throw e;
    }
  });
}
