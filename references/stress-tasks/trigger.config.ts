import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  compatibilityFlags: ["run_engine_v2"],
  project: "proj_stresstaskslocaldevx",
  logLevel: "debug",
  maxDuration: 3600,
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 1,
    },
  },
  machine: "small-2x",
});
