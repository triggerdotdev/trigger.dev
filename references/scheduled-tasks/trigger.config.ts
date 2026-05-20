import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_qcibamtpklwidqfzzyir",
  runtime: "node",
  machine: "small-1x",
  maxDuration: 60,
  dirs: ["./src/trigger"],
  logLevel: "debug",
  compatibilityFlags: ["run_engine_v2"],
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
