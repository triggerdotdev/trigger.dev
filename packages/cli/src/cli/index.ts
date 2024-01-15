import { Command } from "commander";
import inquirer from "inquirer";
import pathModule from "node:path";
import { createIntegrationCommand } from "../commands/createIntegration";
import { devCommand } from "../commands/dev";
import { whoamiCommand } from "../commands/whoami.js";
import { initCommand } from "../commands/init";
import { CLOUD_TRIGGER_URL, COMMAND_NAME } from "../consts";
import { telemetryClient } from "../telemetry/telemetry";
import { getVersion } from "../utils/getVersion";
import { updateCommand } from "../commands/update";
import { sendEventCommand } from "../commands/sendEvent";
import { checkApiKeyIsDevServer } from "../utils/getApiKeyType";

export const program = new Command();

program
  .name(COMMAND_NAME)
  .description("The Trigger.dev CLI")
  .version(getVersion(), "-v, --version", "Display the version number");

program
  .command("init")
  .description("Initialize Trigger.dev in your project")
  .option("-p, --project-path <project-path>", "The path to the project", ".")
  .option("-k, --api-key <api-key>", "The development API key to use for the project.")
  .option(
    "-e, --endpoint-id <endpoint-id>",
    "The unique ID for the endpoint to use for this project. (e.g. my-project)"
  )
  .option(
    "-t, --trigger-url <trigger-url>",
    "The URL of the Trigger.dev instance to use.",
    createUrlValidator("--trigger-url")
  )
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (options) => {
    try {
      await initCommand(options);
    } catch (e) {
      telemetryClient.init.failed("unknown", options, e);
      throw e;
    }
  });

program
  .command("dev")
  .description("Tunnel your local project to Trigger.dev and start running jobs")
  .argument("[path]", "The path to the project", ".")
  .option("-p, --port <port>", "Override the local port your server is on")
  .option("-H, --hostname <hostname>", "Override the hostname on which the application is served")
  .option("-e, --env-file <name>", "Override the name of the env file to load")
  .option(
    "-i, --client-id <name>",
    "The ID of the client to use for this project. Will use the value from the package.json file if not provided."
  )
  .option(
    "-h, --handler-path <handler path>",
    "The URI path to the API handler function to use for this project.",
    "/api/trigger"
  )
  .option(
    "-t, --tunnel <url>",
    "An optional custom tunnel URL. Use only if you already have an open tunnel to your local dev server."
  )
  .option("-s, --https", "allows enabled https for the tunnel")
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (path, options) => {
    try {
      await devCommand(path, options);
    } catch (e) {
      telemetryClient.dev.failed("unknown", options, e);
      throw e;
    }
  });

program
  .command("create-integration")
  .description("Create a new integration package for Trigger.dev")
  .argument("[path]", "The path where you would like the package to be created", ".")
  .option(
    "-n, --package-name <package name>",
    "The name of the package to create (e.g. @trigger.dev/slack)"
  )
  .option(
    "-s, --sdk-package <integration package>",
    "The name of the SDK package to use (e.g. @slack/web-api)"
  )
  .option(
    "-o --openai-key <open ai api key>",
    "The OpenAI API key to use to generate the initial code for this integration"
  )
  .option(
    "-oo --openai-org <open ai org>",
    "The OpenAI org id to use to generate the initial code for this integration"
  )
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (path, options) => {
    await createIntegrationCommand(path, options);
  });

program
  .command("update")
  .description(
    "Updates all @trigger.dev/* packages to their latest compatible versions or the specified version"
  )
  .argument("[path]", "The path to the directory that contains the package.json file", ".")
  .option("--to <version tag>", "The version to update to (ex: 2.1.4)", "latest")
  .action(async (path, options) => {
    await updateCommand(path, options);
  });

program
  .command("whoami")
  .description("display the current logged in user and project details")
  .argument("[path]", "The path to the project", ".")
  .option("-p, --port <port>", "The local port your server is on", "3000")
  .option("-e, --env-file <name>", "The name of the env file to load", ".env.local")
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (path, options) => {
    try {
      await whoamiCommand(path, options);
    } catch (e) {
      throw e;
    }
  });

program
  .command("send-event")
  .description("Sends an event to the Trigger.dev API")
  .argument("[path]", "The path to the project", ".")
  .option("-e, --env-file <name>", "The name of the env file to load", ".env.local")
  .requiredOption("-n, --name <name>", "The name of the event to send")
  .requiredOption("-p, --payload <payload>", "The JSON payload to send with the event")
  .option("-i, --id <id>", "The ID of the event to send")
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (path, options) => {
    try {
      await sendEventCommand(path, options);
    } catch (e) {
      throw e;
    }
  });

export const promptTriggerUrl = async (): Promise<string> => {
  const { instanceType } = await inquirer.prompt<{
    instanceType: "cloud" | "self-hosted";
  }>([
    {
      type: "list",
      name: "instanceType",
      message: "Are you using the Trigger.dev cloud or self-hosted?",
      choices: [
        {
          name: `Trigger.dev Cloud (${CLOUD_TRIGGER_URL})`,
          value: "cloud",
          default: true,
        },
        {
          name: "Self hosted",
          value: "self-hosted",
        },
      ],
    },
  ]);

  if (instanceType === "cloud") {
    return CLOUD_TRIGGER_URL;
  }

  const { triggerUrl } = await inquirer.prompt<{ triggerUrl: string }>({
    type: "input",
    name: "triggerUrl",
    message: "Enter the URL of your self-hosted Trigger.dev instance",
    filter: (input) => {
      return tryToCreateValidUrlFromValue(input);
    },
    validate: (input) => {
      if (!input) {
        return "Please enter the URL of your self-hosted Trigger.dev instance";
      }

      const possibleUrl = tryToCreateValidUrlFromValue(input);

      try {
        new URL(possibleUrl);
      } catch (e) {
        return "Please enter a valid URL";
      }

      return true;
    },
  });

  return triggerUrl;
};

export const promptApiKey = async (instanceUrl: string): Promise<string> => {
  // First prompt if they want to enter their API key now, and if they say Yes, then prompt for it and return it
  const { apiKey } = await inquirer.prompt<{ apiKey: string }>({
    type: "password",
    name: "apiKey",
    message: `Enter your secret dev API key (Find yours ➡️ ${instanceUrl})`,
    validate: (input) => {
      // Make sure they enter something like tr_dev_********
      if (!input) {
        return "Please enter your secret dev API key";
      }

      const result = checkApiKeyIsDevServer(input);

      if (result.success) {
        return true;
      }

      if (!result.type) {
        return "Please enter a valid development API key (should start with tr_dev_)";
      }

      return `Please enter your secret dev API key, you've entered a ${result.type.environment} ${result.type.type} key`;
    },
  });

  return apiKey;
};

export const promptEndpointSlug = async (path: string): Promise<string> => {
  const { endpointSlug } = await inquirer.prompt<{
    endpointSlug: string;
  }>({
    type: "input",
    name: "endpointSlug",
    default: slugify(pathModule.basename(path)),
    message: "Enter an ID for this project",
    validate: (input) => {
      if (!input) {
        return "Please enter an ID for this project";
      }

      return true;
    },
  });

  return endpointSlug;
};

export const obfuscateApiKey = (apiKey: string) => {
  const [prefix, slug, secretPart] = apiKey.split("_") as [string, string, string];
  return `${prefix}_${slug}_${"*".repeat(secretPart.length)}`;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Create a URL validator for a specific flag name
// If the input is a string like test-cloud.trigger.dev, we should automatically add https://
// If the input is a string like localhost:3030, we should automatically add http://
function createUrlValidator(flagName: string): (input: string) => string {
  return (input: string) => {
    try {
      const possibleUrl = tryToCreateValidUrlFromValue(input);

      new URL(possibleUrl);

      return possibleUrl;
    } catch (e) {
      throw new Error(`Please enter a valid URL for the ${flagName} flag`);
    }
  };
}

function tryToCreateValidUrlFromValue(input: string): string {
  let possibleUrl = input;

  if (!input.startsWith("http://") && !input.startsWith("https://")) {
    possibleUrl = input.includes("localhost") ? `http://${input}` : `https://${input}`;
  }

  return possibleUrl;
}
