import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { containerTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import type { PrismaClient, PrismaReplicaClient } from "~/db.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";

type OpLog = Array<{ label: string; model?: string; operation: string }>;

function instrument<T>(client: T, label: string, log: OpLog): T {
  return (client as any).$extends({
    name: `spy-${label}`,
    query: {
      $allOperations({ model, operation, args, query }: any) {
        log.push({ label, model, operation });
        return query(args);
      },
    },
  }) as T;
}

vi.setConfig({ testTimeout: 60_000 });

describe("EnvironmentVariablesRepository control-plane read routing", () => {
  containerTest(
    "getEnvironmentVariables reads SecretStore from the replica only when readFromReplica is set, returning the same values",
    async ({ prisma }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const projectId = environment.projectId;
      const environmentId = environment.id;

      await prisma.secretStore.create({
        data: {
          key: `environmentvariable:${projectId}:${environmentId}:MY_VAR`,
          value: { secret: "hello-from-db" },
        },
      });

      const log: OpLog = [];
      const writer = instrument(prisma, "writer", log) as unknown as PrismaClient;
      const replica = instrument(prisma, "replica", log) as unknown as PrismaReplicaClient;
      const repository = new EnvironmentVariablesRepository(writer, replica);

      log.length = 0;
      const viaReplica = await repository.getEnvironmentVariables(
        projectId,
        environmentId,
        undefined,
        {
          readFromReplica: true,
        }
      );
      expect(viaReplica).toContainEqual({ key: "MY_VAR", value: "hello-from-db" });

      const replicaSecretOps = log.filter((l) => l.model === "SecretStore");
      expect(replicaSecretOps.length).toBeGreaterThan(0);
      expect(replicaSecretOps.every((l) => l.label === "replica")).toBe(true);
      expect(log.some((l) => l.model === "SecretStore" && l.label === "writer")).toBe(false);

      log.length = 0;
      const viaWriter = await repository.getEnvironmentVariables(projectId, environmentId);
      expect(viaWriter).toContainEqual({ key: "MY_VAR", value: "hello-from-db" });

      const writerSecretOps = log.filter((l) => l.model === "SecretStore");
      expect(writerSecretOps.length).toBeGreaterThan(0);
      expect(writerSecretOps.every((l) => l.label === "writer")).toBe(true);
    }
  );
});
