import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  compatibilityFlags: ["run_engine_v2"],
  project: "proj_event_system_ref",
  logLevel: "debug",
  maxDuration: 300,
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
});
