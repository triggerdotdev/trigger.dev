import type { TriggerConfig, ResolveEnvironmentVariablesFunction } from "@trigger.dev/sdk/v3";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";
import { AppDataSource } from "@/trigger/orm";
import { InfisicalClient } from "@infisical/sdk";

export { handleError } from "./src/handleError";

export const resolveEnvVars: ResolveEnvironmentVariablesFunction = async ({
  projectRef,
  env,
  environment,
}) => {
  if (env.INFISICAL_CLIENT_ID === undefined || env.INFISICAL_CLIENT_SECRET === undefined) {
    return;
  }

  const client = new InfisicalClient({
    clientId: env.INFISICAL_CLIENT_ID,
    clientSecret: env.INFISICAL_CLIENT_SECRET,
  });

  const secrets = await client.listSecrets({
    environment,
    projectId: env.INFISICAL_PROJECT_ID!,
  });

  return {
    variables: secrets.map((secret) => ({
      name: secret.secretKey,
      value: secret.secretValue,
    })),
  };
};

export const config: TriggerConfig = {
  project: "yubjwjsfkxnylobaqvqz",
  machine: "small-2x",
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 4,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  enableConsoleLogging: false,
  additionalPackages: ["wrangler@3.35.0", "pg@8.11.5"],
  additionalFiles: ["./wrangler/wrangler.toml"],
  dependenciesToBundle: [/@sindresorhus/, "escape-string-regexp"],
  instrumentations: [new OpenAIInstrumentation()],
  logLevel: "info",
  onStart: async (payload, { ctx }) => {
    if (ctx.organization.id === "clsylhs0v0002dyx75xx4pod1") {
      console.log("Initializing the app data source");

      await AppDataSource.initialize();
    }
  },
  onFailure: async (payload, error, { ctx }) => {
    console.log(`Task ${ctx.task.id} failed ${ctx.run.id}`);

    throw error;
  },
};
