import { defineConfig } from "@trigger.dev/sdk";

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
});
