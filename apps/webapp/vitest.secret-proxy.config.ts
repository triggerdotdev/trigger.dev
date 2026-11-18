import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
    conditions: ["@triggerdotdev/source", "node"],
  },
  ssr: {
    resolve: {
      conditions: ["@triggerdotdev/source", "node"],
      externalConditions: ["@triggerdotdev/source", "node"],
    },
  },
  test: {
    include: [
      "test/secretProxy.test.ts",
      "test/secretProxySupervisor.test.ts",
      "test/workerQueueEnvironmentOverrides.test.ts",
      "test/environmentEncryption.test.ts",
      "test/vercelExistingVariables.test.ts",
      "test/environmentVariablesRepository.test.ts",
      "test/environmentVariablesReplicaRouting.test.ts",
      "test/environmentVariableApiAccess.test.ts",
      "test/environmentVariableApiAccessSourcePat.test.ts",
      "test/environmentVariableRules.test.ts",
      "test/deploymentBuildEnvVarsRoute.test.ts",
      "test/environmentEncryptionAttemptFailure.test.ts",
      "test/workloadSuspendGate.test.ts",
      "app/services/oidc/runTokenVerify.test.ts",
    ],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: 1,
  },
});
