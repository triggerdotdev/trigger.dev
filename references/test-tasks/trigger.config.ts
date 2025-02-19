import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  runtime: "node",
  project: "proj_qwdshjjnuoepcuupfuvo",
  machine: "small-1x",
  maxDuration: 3600,
  dirs: ["./src/trigger"],
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 10,
      minTimeoutInMs: 5_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
});
