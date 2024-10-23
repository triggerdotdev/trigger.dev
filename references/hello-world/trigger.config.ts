import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: "proj_rrkpdguyagvsoktglnod",
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
  build: {
    extensions: [
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
