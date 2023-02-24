import chalk from "chalk";
import { Command } from "commander";
import inquirer from "inquirer";
import terminalLink from "terminal-link";
import {
  CREATE_TRIGGER,
  DEFAULT_APP_NAME as DEFAULT_PROJECT_NAME,
} from "../consts.js";
import { getUserPkgManager } from "../utils/getUserPkgManager.js";
import { getVersion } from "../utils/getVersion.js";
import { logger } from "../utils/logger.js";
import { getTemplates } from "../utils/triggerApi.js";

export interface CliFlags {
  noGit: boolean;
  noInstall: boolean;
  noTelemetry: boolean;
  projectName: string;
  apiKey?: string;
}

export interface CliResults {
  templateName: string;
  flags: CliFlags;
}

const defaultOptions: CliResults = {
  templateName: "blank-starter",
  flags: {
    noGit: false,
    noInstall: false,
    noTelemetry: false,
    projectName: DEFAULT_PROJECT_NAME,
  },
};

export const runCli = async () => {
  const cliResults = defaultOptions;

  const program = new Command().name(CREATE_TRIGGER);

  program
    .description("A CLI for creating Trigger.dev projects")
    .argument(
      "[template-name]",
      "The name of the template to use, e.g. basic-starter",
      "blank-starter"
    )
    .option(
      "-p, --projectName <project-name>",
      "The name of the project, as well as the name of the directory to create. Can be a path to a directory, e.g. ~/projects/my-project",
      false
    )
    .option(
      "-k, --apiKey <api-key>",
      "The development API key to use for the project. Visit https://app.trigger.dev to get yours",
      false
    )
    .option(
      "--noGit",
      "Explicitly tell the CLI to not initialize a new git repo in the project",
      false
    )
    .option(
      "--noInstall",
      "Explicitly tell the CLI to not run the package manager's install command",
      false
    )
    .option(
      "--noTelemetry",
      "Explicitly tell the CLI to not send usage data to Trigger.dev",
      false
    )
    .version(getVersion(), "-v, --version", "Display the version number")
    .addHelpText(
      "afterAll",
      `\n The create-trigger CLI was inspired by ${chalk
        .hex("#E8DCFF")
        .bold("create-t3-stack")} \n`
    )
    .parse(process.argv);

  const templateName = program.args[0];

  if (templateName) {
    cliResults.templateName = templateName;
  }

  cliResults.flags = program.opts();

  try {
    if (
      process.env.SHELL?.toLowerCase().includes("git") &&
      process.env.SHELL?.includes("bash")
    ) {
      logger.warn(`  WARNING: It looks like you are using Git Bash which is non-interactive. Please run create-t3-app with another
  terminal such as Windows Terminal or PowerShell if you want to use the interactive CLI.`);

      const error = new Error("Non-interactive environment");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (error as any).isTTYError = true;
      throw error;
    }

    if (!templateName) {
      cliResults.templateName = await promptTemplateName(
        cliResults.templateName
      );
    }

    if (!cliResults.flags.projectName) {
      cliResults.flags.projectName = await promptProjectName();
    }

    if (!cliResults.flags.apiKey) {
      cliResults.flags.apiKey = await promptApiKey();
    }

    if (!cliResults.flags.noGit) {
      cliResults.flags.noGit = !(await promptGit());
    }

    if (!cliResults.flags.noInstall) {
      cliResults.flags.noInstall = !(await promptInstall());
    }
  } catch (err) {
    // If the user is not calling create-trigger from an interactive terminal, inquirer will throw an error with isTTYError = true
    // If this happens, we catch the error, tell the user what has happened, and then continue to run the program with a default trigger project
    // Otherwise we have to do some fancy namespace extension logic on the Error type which feels overkill for one line
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (err instanceof Error && (err as any).isTTYError) {
      logger.warn(
        `${CREATE_TRIGGER} needs an interactive terminal to provide options`
      );

      const { shouldContinue } = await inquirer.prompt<{
        shouldContinue: boolean;
      }>({
        name: "shouldContinue",
        type: "confirm",
        message: `Continue creating a trigger.dev project?`,
        default: true,
      });

      if (!shouldContinue) {
        logger.info("Exiting...");
        process.exit(0);
      }

      logger.info(
        `Bootstrapping the default Trigger.dev template in ./${cliResults.templateName}`
      );
    } else {
      throw err;
    }
  }

  return cliResults;
};

const promptTemplateName = async (
  defaultTemplateName: string
): Promise<string> => {
  const templates = await getTemplates();

  if (templates.length === 0) {
    return defaultTemplateName;
  }

  const defaultTemplate = templates.find(
    (template) => template.slug === defaultTemplateName
  );

  const templateChoicesWithoutDefault = templates
    .filter((template) => template.slug !== defaultTemplateName)
    .map((template) => ({
      name: `${template.shortTitle} - ${template.description} [${terminalLink(
        "View more",
        template.repositoryUrl
      )}]`,
      value: template.slug,
    }));

  const separator = new inquirer.Separator();

  const choices = defaultTemplate
    ? [
        {
          name: `${defaultTemplate.shortTitle} - ${
            defaultTemplate.description
          } [${terminalLink("View more", defaultTemplate.repositoryUrl)}]`,
          value: defaultTemplate.slug,
        },
        separator,
        ...templateChoicesWithoutDefault,
      ]
    : templateChoicesWithoutDefault;

  const { templateName } = await inquirer.prompt<{ templateName: string }>({
    name: "templateName",
    type: "list",
    message: "What template would you like to use?",
    choices,
    default: defaultTemplateName,
  });

  logger.success(`Great! We're using the ${templateName} template`);

  return templateName;
};

const promptProjectName = async (): Promise<string> => {
  const { projectName } = await inquirer.prompt<{ projectName: string }>({
    name: "projectName",
    type: "input",
    message: "What would you like to name your project?",
    default: DEFAULT_PROJECT_NAME,
  });

  logger.success(`Great! We're creating your project at ${projectName}`);

  return projectName;
};

const promptApiKey = async (): Promise<string | undefined> => {
  // First prompt if they want to enter their API key now, and if they say Yes, then prompt for it and return it
  const { apiKey } = await inquirer.prompt<{ apiKey: string | undefined }>({
    type: "input",
    name: "apiKey",
    message: "Enter your development API key (optional)",
    default: undefined,
    validate: (input) => {
      // Make sure they enter something like trigger_development_********
      if (input && !input.startsWith("trigger_development_")) {
        return "Please enter a valid API key (e.g. trigger_development_********) or leave blank to skip";
      }

      return true;
    },
  });

  if (apiKey) {
    logger.success(
      `Fantastic! We'll save the API key (trigger_development_********) in the .env file.`
    );
  }

  return apiKey;
};

const promptGit = async (): Promise<boolean> => {
  const { git } = await inquirer.prompt<{ git: boolean }>({
    name: "git",
    type: "confirm",
    message: "Initialize a new git repository?",
    default: true,
  });

  if (git) {
    logger.success("Nice one! Initializing repository!");
  } else {
    logger.info("Sounds good! You can come back and run git init later.");
  }

  return git;
};

const promptInstall = async (): Promise<boolean> => {
  const pkgManager = getUserPkgManager();

  const { install } = await inquirer.prompt<{ install: boolean }>({
    name: "install",
    type: "confirm",
    message:
      `Would you like us to run '${pkgManager}` +
      (pkgManager === "yarn" ? `'?` : ` install'?`),
    default: true,
  });

  if (install) {
    logger.success("Alright. We'll install the dependencies for you!");
  } else {
    if (pkgManager === "yarn") {
      logger.info(
        `No worries. You can run '${pkgManager}' later to install the dependencies.`
      );
    } else {
      logger.info(
        `No worries. You can run '${pkgManager} install' later to install the dependencies.`
      );
    }
  }

  return install;
};
