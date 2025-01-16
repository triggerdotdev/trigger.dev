import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  runtime: "bun",
  project: "proj_uxbxncnbsyamyxeqtucu",
  maxDuration: 3600,
  machine: "small-2x",
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
});
