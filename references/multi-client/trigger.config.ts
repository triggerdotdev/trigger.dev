import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  compatibilityFlags: ["run_engine_v2"],
  project: "proj_zzoylbutktripkqnwrln",
  logLevel: "info",
  maxDuration: 600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 1,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
      randomize: false,
    },
  },
  machine: "small-1x",
});
