import { Logger, LogLevel } from "internal-bridge/logger";
import { readFile } from "node:fs/promises";

export type TriggerClientOptions = {
  apiKey?: string;
  endpoint?: string;
  logLevel?: LogLevel;
};

export type EntryPointRecord = {
  id: string;
  url: string;
};

export class TriggerClient {
  #endpoint: string;
  #options: TriggerClientOptions;
  #logger: Logger;

  constructor(options: TriggerClientOptions) {
    this.#options = options;

    this.#endpoint =
      this.#options.endpoint ??
      process.env.TRIGGER_API_URL ??
      "https://app.trigger.dev";
    this.#logger = new Logger("trigger.dev", this.#options.logLevel);
  }

  async registerEntryPoint(options: {
    url: string;
  }): Promise<EntryPointRecord> {
    const apiKey = await this.#apiKey();

    const response = await fetch(`${this.#endpoint}/api/v1/entryPoints`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        url: options.url,
      }),
    });

    if (response.status !== 200) {
      throw new Error(
        `Failed to register entry point, got status code ${response.status}`
      );
    }

    return await response.json();
  }

  async #apiKey() {
    const apiKey = getApiKey();

    if (apiKey.status === "invalid") {
      const chalk = (await import("chalk")).default;
      const terminalLink = (await import("terminal-link")).default;

      throw new Error(
        `${chalk.red("Trigger.dev error")}: Invalid API key ("${chalk.italic(
          apiKey.apiKey
        )}"), please set the TRIGGER_API_KEY environment variable or pass the apiKey option to a valid value. ${terminalLink(
          "Get your API key here",
          "https://app.trigger.dev",
          {
            fallback(text, url) {
              return `${text} 👉 ${url}`;
            },
          }
        )}`
      );
    } else if (apiKey.status === "missing") {
      const chalk = (await import("chalk")).default;
      const terminalLink = (await import("terminal-link")).default;

      throw new Error(
        `${chalk.red(
          "Trigger.dev error"
        )}: Missing an API key, please set the TRIGGER_API_KEY environment variable or pass the apiKey option to the Trigger constructor. ${terminalLink(
          "Get your API key here",
          "https://app.trigger.dev",
          {
            fallback(text, url) {
              return `${text} 👉 ${url}`;
            },
          }
        )}`
      );
    }

    return apiKey.apiKey;
  }
}

function getApiKey(key?: string) {
  const apiKey = key ?? process.env.TRIGGER_API_KEY;

  if (!apiKey) {
    return { status: "missing" as const };
  }

  // Validate the api_key format (should be trigger_{env}_XXXXX)
  const isValid = apiKey.match(/^trigger_[a-z]+_[a-zA-Z0-9]+$/);

  if (!isValid) {
    return { status: "invalid" as const, apiKey };
  }

  return { status: "valid" as const, apiKey };
}

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const messageKey = (runId: string, key: string) => `${runId}:${key}`;

function highPrecisionTimestamp() {
  const [seconds, nanoseconds] = process.hrtime();

  return seconds * 1e9 + nanoseconds;
}

// Gets the environment variables prefixed with npm_package_triggerdotdev_ and returns them as an object
// Alternatively, if there is a npm_package_json env var set, we can try and read the file and parse it
async function getTriggerPackageEnvVars(
  env: NodeJS.ProcessEnv
): Promise<Record<string, string | number | boolean>> {
  if (!env) {
    return {};
  }

  // Path to the package.json file
  if (env.npm_package_json) {
    try {
      const packageJson = JSON.parse(
        await readFile(env.npm_package_json, "utf8")
      );

      if (packageJson.triggerdotdev) {
        return packageJson.triggerdotdev;
      }
    } catch (err) {
      // Ignore
    }
  }

  const envVars = Object.entries(env)
    .filter(([key]) => key.startsWith("npm_package_triggerdotdev_"))
    .map(([key, value]) => [
      key.replace("npm_package_triggerdotdev_", ""),
      value,
    ]);

  return Object.fromEntries(envVars);
}

async function getRemoteUrl(cwd: string) {
  try {
    const gitRemoteOriginUrl = (await import("git-remote-origin-url")).default;
    return await gitRemoteOriginUrl({ cwd });
  } catch (err) {
    return;
  }
}

async function safeGetRepoInfo() {
  try {
    const gitRepoInfo = (await import("git-repo-info")).default;
    return gitRepoInfo();
  } catch (err) {
    return;
  }
}

// Get all env vars that are prefixed with TRIGGER_ (exccpt for TRIGGER_API_KEY)
function gatherEnvVars(env: NodeJS.ProcessEnv): Record<string, string> {
  if (!env) {
    return {};
  }

  const envVars = Object.entries(env)
    .filter(([key]) => key.startsWith("TRIGGER_") && key !== "TRIGGER_API_KEY")
    .map(([key, value]) => [key.replace("TRIGGER_", ""), `${value}`]);

  return Object.fromEntries(envVars);
}
