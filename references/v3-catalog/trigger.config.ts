import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";
import { defineConfig } from "@trigger.dev/sdk/v3";
import { emitDecoratorMetadata } from "@trigger.dev/sdk/v3/extensions";

export default defineConfig({
  project: "yubjwjsfkxnylobaqvqz",
  machine: "small-2x",
  instrumentations: [new OpenAIInstrumentation()],
  additionalFiles: ["wrangler/wrangler.toml"],
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 4,
      minTimeoutInMs: 10000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: true,
    },
  },
  enableConsoleLogging: false,
  logLevel: "info",
  onStart: async (payload, { ctx }) => {
    console.log(`Task ${ctx.task.id} started ${ctx.run.id}`);
  },
  onFailure: async (payload, error, { ctx }) => {
    console.log(`Task ${ctx.task.id} failed ${ctx.run.id}`);
  },
  build: {
    extensions: [emitDecoratorMetadata()],
    external: ["@ffmpeg-installer/ffmpeg"],
  },
});
