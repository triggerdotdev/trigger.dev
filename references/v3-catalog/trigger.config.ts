import type { TriggerConfig } from "@trigger.dev/sdk/v3";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";

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
  additionalPackages: ["wrangler@3.35.0"],
  additionalFiles: ["./wrangler/wrangler.toml"],
  dependenciesToBundle: [/@sindresorhus/, "escape-string-regexp"],
  instrumentations: [new OpenAIInstrumentation()],
  logLevel: "log",
  enableConsoleLogging: true,
};
