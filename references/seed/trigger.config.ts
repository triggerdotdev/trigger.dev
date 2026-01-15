import { defineConfig } from "@trigger.dev/sdk/v3";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";
import { lightpanda } from "@trigger.dev/build/extensions/lightpanda";

export default defineConfig({
  compatibilityFlags: ["run_engine_v2"],
  project: process.env.TRIGGER_PROJECT_REF!,
  experimental_processKeepAlive: {
    enabled: true,
    maxExecutionsPerProcess: 20,
  },
  logLevel: "debug",
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
  machine: "small-2x",
  build: {
    extensions: [
      lightpanda(),
      syncEnvVars(async (ctx) => {
        return [
          { name: "SYNC_ENV", value: ctx.environment },
          { name: "BRANCH", value: ctx.branch ?? "NO_BRANCH" },
          { name: "BRANCH", value: "PARENT", isParentEnv: true },
          { name: "SECRET_KEY", value: "secret-value" },
          { name: "ANOTHER_SECRET", value: "another-secret-value" },
        ];
      }),
      {
        name: "npm-token",
        onBuildComplete: async (context, manifest) => {
          if (context.target === "dev") {
            return;
          }

          context.addLayer({
            id: "npm-token",
            build: {
              env: {
                NPM_TOKEN: manifest.deploy.env?.NPM_TOKEN,
              },
            },
          });
        },
      },
    ],
  },
});
