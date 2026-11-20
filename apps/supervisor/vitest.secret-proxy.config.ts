import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { conditions: ["@triggerdotdev/source", "node"] },
  ssr: { resolve: { conditions: ["@triggerdotdev/source", "node"] } },
  test: {
    include: [
      "src/services/secretProxyBindings.test.ts",
      "src/services/secretProxyPlacements.test.ts",
      "src/services/secretProxyValidation.test.ts",
      "src/env.test.ts",
      "src/workloadServer/workloadServer.attemptStart.test.ts",
      "src/workloadServer/workloadServer.secretProxy.test.ts",
      "src/workloadServer/workloadServer.heartbeat.test.ts",
      "src/workloadServer/workloadServer.auth.test.ts",
    ],
    fileParallelism: false,
    server: { deps: { inline: [/@trigger.dev\//, /@internal\//] } },
  },
});
