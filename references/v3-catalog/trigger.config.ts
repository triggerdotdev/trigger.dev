import type { TriggerConfig } from "@trigger.dev/sdk/v3";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";
import { AppDataSource } from "@/trigger/orm";

export { handleError } from "./src/handleError";

export const config: TriggerConfig = {
  project: "yubjwjsfkxnylobaqvqz",
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
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
