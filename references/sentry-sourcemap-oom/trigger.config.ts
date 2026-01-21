import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_sentry_oom_test",
  logLevel: "debug",
  maxDuration: 60,
  // Use small-1x machine to test memory constraints (0.5GB RAM)
  machine: "small-1x",
});
