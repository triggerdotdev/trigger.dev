import type { TriggerConfig } from "@trigger.dev/sdk/v3";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";

export const config: TriggerConfig = {
  project: "yubjwjsfkxnylobaqvqz",
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
  enableConsoleLogging: true,
  instrumentations: [new OpenAIInstrumentation()],
};
