import { intro, isCancel, log, outro, select, text } from "@clack/prompts";
import { context, trace } from "@opentelemetry/api";
import { GetProjectResponseBody, flattenAttributes } from "@trigger.dev/core/v3";
import { recordSpanException } from "@trigger.dev/core/v3/workers";
import chalk from "chalk";
import { Command, Option as CommandOption } from "commander";
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree } from "jsonc-parser";
import { writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { addDependency, addDevDependency, detectPackageManager } from "nypm";
import { resolveTSConfig } from "pkg-types";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
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
import { loadConfig } from "../config.js";
import { cliLink } from "../utilities/cliOutput.js";
import {
  createFileFromTemplate,
  generateTemplateUrl,
} from "../utilities/createFileFromTemplate.js";
import { createFile, pathExists, readFile } from "../utilities/fileSystem.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { spinner } from "../utilities/windows.js";
import { login } from "./login.js";
import { VERSION } from "../version.js";

const cliVersion = VERSION as string;
const cliTag = cliVersion.includes("v4-beta") ? "v4-beta" : "latest";

const InitCommandOptions = CommonCommandOptions.extend({
  projectRef: z.string().optional(),
  overrideConfig: z.boolean().default(false),
  tag: z.string().default(cliVersion),
  skipPackageInstall: z.boolean().default(false),
  runtime: z.string().default("node"),
  pkgArgs: z.string().optional(),
  gitRef: z.string().default("main"),
  javascript: z.boolean().default(false),
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
      .option("--javascript", "Initialize the project with JavaScript instead of TypeScript", false)
      .option(
        "-t, --tag <package tag>",
        "The version of the @trigger.dev/sdk package to install",
        cliVersion
      )
      .option(
        "-r, --runtime <runtime>",
        "Which runtime to use for the project. Currently only supports node.",
        "node"
      )
      .option("--skip-package-install", "Skip installing the @trigger.dev/sdk package")
      .option("--override-config", "Override the existing config file if it exists")
      .option(
        "--pkg-args <args>",
        "Additional arguments to pass to the package manager, accepts CSV for multiple args"
      )
  )
    .addOption(
      new CommandOption(
        "--git-ref <git ref>",
        "The git ref to use when fetching templates from GitHub"
      ).hideHelp()
    )
    .action(async (path, options) => {
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

  const cwd = resolve(process.cwd(), dir);

  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
  });

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
    "cli.config.profile": authorization.profile,
  });

  const tsconfigPath = await tryResolveTsConfig(cwd);

  if (!options.overrideConfig) {
    try {
      // check to see if there is an existing trigger.dev config file in the project directory
      const result = await loadConfig({ cwd });

      if (result.configFile && result.configFile !== "trigger.config") {
        outro(
          result.configFile
            ? `Project already initialized: Found config file at ${result.configFile}. Pass --override-config to override`
            : "Project already initialized"
        );

        return;
      }
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

  const language = options.javascript ? "javascript" : "typescript";

  // Create the trigger dir
  const triggerDir = await createTriggerDir(dir, options, language);

  // Create the config file
  await writeConfigFile(dir, selectedProject, options, triggerDir, language);

  // Add trigger.config.ts to tsconfig.json
  if (tsconfigPath && language === "typescript") {
    await addConfigFileToTsConfig(tsconfigPath, options);
  }

  // Ignore .trigger dir
  await gitIgnoreDotTriggerDir(dir, options);

  const projectDashboard = cliLink(
    "project dashboard",
    `${authorization.dashboardUrl}/projects/v3/${selectedProject.externalRef}`
  );

  log.success("Successfully initialized project for Trigger.dev v3 🫡");
  log.info("Next steps:");
  log.info(
    `   1. To start developing, run ${chalk.green(
      `npx trigger.dev@${cliTag} dev${options.profile ? "" : ` --profile ${options.profile}`}`
    )} in your project directory`
  );
  log.info(`   2. Visit your ${projectDashboard} to view your newly created tasks.`);
  log.info(
    `   3. Head over to our ${cliLink("v3 docs", "https://trigger.dev/docs")} to learn more.`
  );
  log.info(
    `   4. Need help? Join our ${cliLink(
      "Discord community",
      "https://trigger.dev/discord"
    )} or email us at ${chalk.cyan("help@trigger.dev")}`
  );

  outro(`Project initialized successfully. Happy coding!`);
}

async function createTriggerDir(
  dir: string,
  options: InitCommandOptions,
  language: "typescript" | "javascript"
) {
  return await tracer.startActiveSpan("createTriggerDir", async (span) => {
    try {
      const defaultValue = join(dir, "src", "trigger");

      const location = await text({
        message: "Where would you like to create the Trigger.dev directory?",
        defaultValue: defaultValue,
        placeholder: defaultValue,
      });

      if (isCancel(location)) {
        throw new OutroCommandError();
      }

      // Ensure that the path is always relative by stripping leading '/' if present
      const relativeLocation = location.replace(/^\//, "");

      const triggerDir = resolve(process.cwd(), relativeLocation);

      logger.debug({ triggerDir });

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
          { value: "schedule", label: "Scheduled Task" },
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
        return { location, isCustomValue: location !== defaultValue };
      }

      const templateUrl = generateTemplateUrl(
        `examples/${example}.${language === "typescript" ? "ts" : "mjs"}`,
        options.gitRef
      );
      const outputPath = join(triggerDir, `example.${language === "typescript" ? "ts" : "mjs"}`);

      await createFileFromTemplate({
        templateUrl,
        outputPath,
        replacements: {},
      });

      const relativeOutputPath = relative(process.cwd(), outputPath);

      log.step(`Created example file at ${relativeOutputPath}`);

      span.end();

      return { location, isCustomValue: location !== defaultValue };
    } catch (e) {
      if (!(e instanceof SkipCommandError)) {
        recordSpanException(span, e);
      }

      span.end();

      throw e;
    }
  });
}

async function gitIgnoreDotTriggerDir(dir: string, options: InitCommandOptions) {
  return await tracer.startActiveSpan("gitIgnoreDotTriggerDir", async (span) => {
    try {
      const projectDir = resolve(process.cwd(), dir);
      const gitIgnorePath = join(projectDir, ".gitignore");

      span.setAttributes({
        "cli.projectDir": projectDir,
        "cli.gitIgnorePath": gitIgnorePath,
      });

      if (!(await pathExists(gitIgnorePath))) {
        // Create .gitignore file
        await createFile(gitIgnorePath, ".trigger");

        log.step(`Added .trigger to .gitignore`);

        span.end();

        return;
      }

      // Check if .gitignore already contains .trigger
      const gitIgnoreContent = await readFile(gitIgnorePath);

      if (gitIgnoreContent.includes(".trigger")) {
        span.end();

        return;
      }

      const newGitIgnoreContent = `${gitIgnoreContent}\n.trigger`;

      await writeFile(gitIgnorePath, newGitIgnoreContent, "utf-8");

      log.step(`Added .trigger to .gitignore`);

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

async function addConfigFileToTsConfig(tsconfigPath: string, options: InitCommandOptions) {
  return await tracer.startActiveSpan("addConfigFileToTsConfig", async (span) => {
    try {
      span.setAttributes({
        "cli.tsconfigPath": tsconfigPath,
      });

      const tsconfigContent = await readFile(tsconfigPath);
      const tsconfigContentTree = parseTree(tsconfigContent, undefined);
      if (!tsconfigContentTree) {
        span.end();

        return;
      }

      const tsconfigIncludeOption = findNodeAtLocation(tsconfigContentTree, ["include"]);
      if (!tsconfigIncludeOption) {
        span.end();

        return;
      }

      const tsConfigFileName = "trigger.config.ts";
      const tsconfigIncludeOptionValue: string[] = getNodeValue(tsconfigIncludeOption);
      if (tsconfigIncludeOptionValue.includes(tsConfigFileName)) {
        span.end();

        return;
      }

      const edits = modify(tsconfigContent, ["include", -1], tsConfigFileName, {
        isArrayInsertion: true,
        formattingOptions: {
          tabSize: 2,
          insertSpaces: true,
          eol: "\n",
        },
      });

      logger.debug("tsconfig.json edits", { edits });

      const newTsconfigContent = applyEdits(tsconfigContent, edits);

      logger.debug("new tsconfig.json content", { newTsconfigContent });

      await writeFile(tsconfigPath, newTsconfigContent, "utf-8");

      log.step(`Added trigger.config.ts to tsconfig.json`);

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
    const projectDir = resolve(process.cwd(), dir);

    const installSpinner = spinner();
    const packageManager = await detectPackageManager(projectDir);

    try {
      span.setAttributes({
        "cli.projectDir": projectDir,
        "cli.packageManager": packageManager?.name,
        "cli.tag": options.tag,
      });

      installSpinner.start(`Adding @trigger.dev/sdk@${options.tag}`);

      await addDependency(`@trigger.dev/sdk@${options.tag}`, { cwd: projectDir, silent: true });

      installSpinner.stop(`@trigger.dev/sdk@${options.tag} installed`);

      installSpinner.start(`Adding @trigger.dev/build@${options.tag} to devDependencies`);

      await addDevDependency(`@trigger.dev/build@${options.tag}`, {
        cwd: projectDir,
        silent: true,
      });

      installSpinner.stop(`@trigger.dev/build@${options.tag} installed`);

      span.end();
    } catch (e) {
      if (options.logLevel === "debug") {
        installSpinner.stop(`Failed to install @trigger.dev/sdk@${options.tag}.`);
      } else {
        installSpinner.stop(
          `Failed to install @trigger.dev/sdk@${options.tag}. Rerun command with --log-level debug for more details.`
        );
      }

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
  options: InitCommandOptions,
  triggerDir: { location: string; isCustomValue: boolean },
  language: "typescript" | "javascript"
) {
  return await tracer.startActiveSpan("writeConfigFile", async (span) => {
    try {
      const spnnr = spinner();
      spnnr.start("Creating config file");

      const projectDir = resolve(process.cwd(), dir);
      const outputPath = join(
        projectDir,
        `trigger.config.${language === "typescript" ? "ts" : "mjs"}`
      );
      const templateUrl = generateTemplateUrl(
        `trigger.config.${language === "typescript" ? "ts" : "mjs"}`,
        options.gitRef
      );

      span.setAttributes({
        "cli.projectDir": projectDir,
        "cli.templatePath": templateUrl,
        "cli.outputPath": outputPath,
        "cli.runtime": options.runtime,
      });

      const result = await createFileFromTemplate({
        templateUrl,
        replacements: {
          projectRef: project.externalRef,
          runtime: options.runtime,
          triggerDirectoriesOption: triggerDir.isCustomValue
            ? `\n  dirs: ["${triggerDir.location}"],`
            : `\n  dirs: ["./src/trigger"],`,
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
        const newProjectLink = cliLink(
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

async function tryResolveTsConfig(cwd: string) {
  try {
    const tsconfigPath = await resolveTSConfig(cwd);
    return tsconfigPath;
  } catch (e) {
    return;
  }
}
