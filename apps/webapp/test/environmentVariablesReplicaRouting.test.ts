import { setupAuthenticatedEnvironment } from "@internal/run-engine/tests";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import type { PrismaClient, PrismaReplicaClient } from "~/db.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { EnvironmentEncryptionService } from "~/services/environmentEncryption/service.server";
import { resolveEncryptionKeyring } from "~/utils/encryptionKeyring.server";
import { $transaction } from "~/db.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";

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
  // Catches: cold encrypted reads using the writer for policy or wrapped-key metadata despite replica routing.
  postgresTest(
    "reads cold policy and key metadata from the selected replica",
    async ({ prisma }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      await prisma.organization.update({
        where: { id: environment.organizationId },
        data: { featureFlags: { [FEATURE_FLAG.environmentEncryptionEnabled]: true } },
      });
      const log: OpLog = [];
      const writer = instrument(prisma, "writer", log) as unknown as PrismaClient;
      const replica = instrument(prisma, "replica", log) as unknown as PrismaReplicaClient;
      const keyring = resolveEncryptionKeyring(undefined, "0123456789abcdef0123456789abcdef");
      const encryption = () =>
        new EnvironmentEncryptionService({
          db: writer,
          transaction: (fn) => $transaction(writer, fn),
          keyring,
          writesEnabled: true,
          defaultWrappingPolicy: {
            wrappingProvider: "PLATFORM_KEYRING",
            wrappingKeyReference: "legacy",
          },
        });
      const writerEncryption = encryption();
      expect(
        await new EnvironmentVariablesRepository(writer, replica, writerEncryption).create(
          environment.projectId,
          {
            environmentIds: [environment.id],
            variables: [{ key: "ENCRYPTED", value: "protected" }],
            override: false,
          }
        )
      ).toEqual({ success: true });
      const repository = new EnvironmentVariablesRepository(writer, replica, encryption());
      log.length = 0;
      expect(
        await repository.getEnvironmentVariables(environment.projectId, environment.id, undefined, {
          readFromReplica: true,
        })
      ).toContainEqual({ key: "ENCRYPTED", value: "protected" });
      expect(log.some((entry) => entry.model === "EnvironmentEncryptionKey")).toBe(true);
      expect(log.every((entry) => entry.label === "replica")).toBe(true);
    }
  );

  postgresTest(
    "getEnvironmentVariables reads SecretStore from the replica only when readFromReplica is set, returning the same values",
    async ({ prisma }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const projectId = environment.projectId;
      const environmentId = environment.id;

      const setupRepository = new EnvironmentVariablesRepository(prisma, prisma);
      expect(
        await setupRepository.create(projectId, {
          environmentIds: [environmentId],
          variables: [{ key: "MY_VAR", value: "hello-from-db" }],
          override: false,
        })
      ).toEqual({ success: true });

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
      expect(log.some((l) => l.label === "writer")).toBe(false);

      log.length = 0;
      const viaWriter = await repository.getEnvironmentVariables(projectId, environmentId);
      expect(viaWriter).toContainEqual({ key: "MY_VAR", value: "hello-from-db" });

      const writerSecretOps = log.filter((l) => l.model === "SecretStore");
      expect(writerSecretOps.length).toBeGreaterThan(0);
      expect(writerSecretOps.every((l) => l.label === "writer")).toBe(true);
    }
  );
});
