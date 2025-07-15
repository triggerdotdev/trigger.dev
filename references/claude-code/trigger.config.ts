import { defineConfig } from "@trigger.dev/sdk/v3";
import { additionalFiles } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  experimental_processKeepAlive: {
    enabled: true,
    maxExecutionsPerProcess: 20,
  },
  experimental_devProcessCwdInBuildDir: true,
  logLevel: "log",
  maxDuration: 3600,
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
  machine: "medium-2x",
  build: {
    external: ["@anthropic-ai/claude-code"],
    extensions: [additionalFiles({ files: [".claude-settings.json"] })],
  },
});
