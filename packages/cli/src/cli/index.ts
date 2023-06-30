import { Command, Option } from "commander";
import inquirer from "inquirer";
import { initCommand } from "../commands/init.js";
import { COMMAND_NAME, DEFAULT_TRIGGER_URL } from "../consts.js";
import { getVersion } from "../utils/getVersion.js";
import pathModule from "node:path";
import { devCommand } from "../commands/dev.js";

export const program = new Command();

program.name(COMMAND_NAME).description("The Trigger.dev CLI").version("0.0.1");

program
  .command("init")
  .description("Initialize Trigger.dev in your Next.js project")
  .option(
    "-p, --project-path <project-path>",
    "The path to the Next.js project",
    "."
  )
  .option(
    "-k, --api-key <api-key>",
    "The development API key to use for the project."
  )
  .option(
    "-e, --endpoint-id <endpoint-id>",
    "The unique ID for the endpoint to use for this project. (e.g. my-nextjs-project)"
  )
  .option(
    "-t, --trigger-url <trigger-url>",
    "The URL of the Trigger.dev instance to use.",
    createUrlValidator("--trigger-url")
  )
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (options) => {
    await initCommand(options);
  });

program
  .command("dev")
  .description(
    "Tunnel your local Next.js project to Trigger.dev and start running jobs"
  )
  .argument("[path]", "The path to the Next.js project", ".")
  .option(
    "-p, --port <port>",
    "The local port your Next.js project is on",
    "3000"
  )
  .option(
    "-e, --env-file <name>",
    "The name of the env file to load",
    ".env.local"
  )
  .version(getVersion(), "-v, --version", "Display the version number")
  .action(async (path, options) => {
    await devCommand(path, options);
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
          name: "Trigger.dev Cloud (https://cloud.trigger.dev)",
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
    return DEFAULT_TRIGGER_URL;
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
    type: "input",
    name: "apiKey",
    message: `Enter your development API key (Find yours ➡️ ${instanceUrl})`,
    validate: (input) => {
      // Make sure they enter something like tr_dev_********
      if (!input) {
        return "Please enter your development API key";
      }

      if (!input.startsWith("tr_dev_")) {
        return "Please enter a valid development API key or leave blank to skip (should start with tr_dev_)";
      }

      return true;
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
    message: "Enter a unique ID for your endpoint",
    validate: (input) => {
      if (!input) {
        return "Please enter a unique slug for your endpoint";
      }

      return true;
    },
  });

  return endpointSlug;
};

export const promptEndpointUrl = async (
  instanceUrl: string
): Promise<string> => {
  const { endpointUrl } = await inquirer.prompt<{
    endpointUrl: string;
  }>({
    type: "input",
    name: "endpointUrl",
    message: "What's the URL of your Next.js project?",
    validate: (input) => {
      if (!input) {
        return "Please enter the URL of your Next.js project";
      }

      // If instanceUrl is a cloud instance, then the URL must be publicly accessible
      const url = new URL(input);
      const triggerUrl = new URL(instanceUrl);

      if (triggerUrl.hostname !== "localhost" && url.hostname === "localhost") {
        return `Your Trigger.dev instance is hosted at ${triggerUrl.hostname}, so your Next.js project must also be publicly accessible. See our docs for more info: https://trigger.dev/docs/documentation/guides/tunneling-localhost`;
      }

      // Make sure triggerUrl and url don't use the same port if they are both localhost
      if (
        triggerUrl.hostname === "localhost" &&
        url.hostname === "localhost" &&
        triggerUrl.port === url.port
      ) {
        return `Your Trigger.dev instance and your Next.js project are both trying to use port ${triggerUrl.port}. Please use a different port for one of them`;
      }

      return true;
    },
  });

  return endpointUrl;
};

export const obfuscateApiKey = (apiKey: string) => {
  const [prefix, slug, secretPart] = apiKey.split("_") as [
    string,
    string,
    string
  ];
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
    possibleUrl = input.includes("localhost")
      ? `http://${input}`
      : `https://${input}`;
  }

  return possibleUrl;
}
