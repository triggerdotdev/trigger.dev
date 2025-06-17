import { defineConfig } from "@trigger.dev/sdk/v3";
import { syncEnvVars } from "@trigger.dev/build/extensions/core";

export default defineConfig({
  compatibilityFlags: ["run_engine_v2"],
  project: "proj_rrkpdguyagvsoktglnod",
  experimental_processKeepAlive: true,
  logLevel: "log",
  maxDuration: 60,
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
      syncEnvVars(async (ctx) => {
        console.log("syncEnvVars", { environment: ctx.environment, branch: ctx.branch });
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
