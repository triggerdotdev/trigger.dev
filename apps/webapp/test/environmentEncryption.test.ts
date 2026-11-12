import { postgresTest } from "@internal/testcontainers";
import {
  $transaction,
  type PrismaClient,
  type PrismaTransactionClient,
} from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  StoredEnvironmentValueSchema,
  parseStoredEnvironmentValue,
} from "~/services/environmentEncryption/crypto.server";
import { EnvironmentEncryptionService } from "~/services/environmentEncryption/service.server";
import { migrateEnvironmentEncryption } from "~/services/environmentEncryption/migration.server";
import {
  ENVIRONMENT_SECRET_VERSION,
  environmentSecretPrefix,
} from "~/services/environmentEncryption/secretStore.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  encryptValue,
  resolveEncryptionKeyring,
  type EncryptionKeyring,
} from "~/utils/encryptionKeyring.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { EnvironmentKeyUnavailableError } from "~/services/environmentEncryption/wrapping.server";
import { buildEnvVarsEnvelope } from "~/v3/services/initializeDeployment/buildEnvVarsEnvelope.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

const keyring = resolveEncryptionKeyring(undefined, "0123456789abcdef0123456789abcdef");
function service(
  db: PrismaClient,
  options: { keyring?: EncryptionKeyring; writesEnabled?: boolean; onUnwrap?: () => void } = {}
) {
  const keys = options.keyring ?? keyring;
  return new EnvironmentEncryptionService({
    db,
    transaction: (fn) => $transaction(db, fn),
    keyring: keys,
    writesEnabled: options.writesEnabled ?? true,
    defaultWrappingPolicy: {
      wrappingProvider: "PLATFORM_KEYRING",
      wrappingKeyReference: keys.activeKeyId,
    },
    onUnwrap: options.onUnwrap,
  });
}
async function seed(
  db: PrismaClient,
  orgFlags: Record<string, boolean> = { [FEATURE_FLAG.environmentEncryptionEnabled]: true }
) {
  const data = await createTestOrgProjectWithMember(db);
  await db.organization.update({
    where: { id: data.organization.id },
    data: { featureFlags: orgFlags },
  });
  const environment = await createRuntimeEnvironment(db, {
    projectId: data.project.id,
    organizationId: data.organization.id,
    type: "PRODUCTION",
  });
  return {
    ...data,
    environment,
    scope: { projectId: data.project.id, environmentId: environment.id },
  };
}

describe("environment encryption", () => {
  // Catches: a historical non-JSON value blocking valid variables, or decryption failures being silently skipped as malformed JSON.
  postgresTest(
    "skips malformed JSON but never hides ciphertext authentication failures",
    async ({ prisma }) => {
      const { scope } = await seed(prisma);
      const prefix = environmentSecretPrefix(scope.projectId, scope.environmentId);
      const malformed = encryptValue("not-json", keyring);
      await prisma.secretStore.createMany({
        data: [
          { key: `${prefix}BAD`, version: "2", value: malformed },
          {
            key: `${prefix}GOOD`,
            version: "2",
            value: encryptValue(JSON.stringify({ secret: "valid" }), keyring),
          },
        ],
      });
      const repository = new EnvironmentVariablesRepository(prisma, prisma, service(prisma));
      expect(
        await repository.getEnvironmentVariables(scope.projectId, scope.environmentId)
      ).toEqual([{ key: "GOOD", value: "valid" }]);
      const tag = `${malformed.tag[0] === "0" ? "1" : "0"}${malformed.tag.slice(1)}`;
      await prisma.secretStore.update({
        where: { key: `${prefix}BAD` },
        data: { value: { ...malformed, tag } },
      });
      await expect(
        repository.getEnvironmentVariables(scope.projectId, scope.environmentId)
      ).rejects.toThrow();
    }
  );

  // Catches: mixed ordering/cursor comparisons skipping values or migration touching neighboring environment prefixes.
  postgresTest(
    "migrates bounded prefix pages without crossing environment boundaries",
    async ({ prisma }) => {
      const { scope } = await seed(prisma);
      const prefix = environmentSecretPrefix(scope.projectId, scope.environmentId);
      const names = ["z", "A", "é", "_", "0"];
      const outsideKey = `${prefix.slice(0, -1)};OTHER`;
      await prisma.secretStore.createMany({
        data: [
          ...names.map((name) => ({
            key: `${prefix}${name}`,
            version: "1",
            value: { secret: name },
          })),
          { key: outsideKey, version: "1", value: { secret: "untouched" } },
        ],
      });
      const encryption = service(prisma);
      const result = await migrateEnvironmentEncryption({
        db: prisma,
        encryption,
        encryptionTransaction: (fn) => $transaction(prisma, fn),
        ...scope,
        apply: true,
        batchSize: 1,
        pauseMs: 0,
      });
      expect(result).toEqual({ scanned: names.length, rewritten: names.length, conflicts: 0 });
      expect(
        (await prisma.secretStore.findFirstOrThrow({ where: { key: outsideKey } })).version
      ).toBe("1");
    }
  );

  // Catches: disabled writes creating policy rows, or an enrollment race making a valid legacy write unreadable.
  postgresTest(
    "keeps disabled writes unfenced and reads late legacy writes after enrollment",
    async ({ prisma }) => {
      const { scope } = await seed(prisma);
      const disabled = service(prisma, { writesEnabled: false });
      const repository = new EnvironmentVariablesRepository(prisma, prisma, disabled);
      expect(
        await repository.create(scope.projectId, {
          override: true,
          environmentIds: [scope.environmentId],
          variables: [{ key: "BEFORE", value: "before" }],
        })
      ).toEqual({ success: true });
      expect(
        await prisma.environmentEncryptionPolicy.count({
          where: { environmentId: scope.environmentId },
        })
      ).toBe(0);
      const late = await disabled.prepareWrite(scope);
      const enrolled = service(prisma);
      const active = await enrolled.prepareWrite(scope);
      const key = `${environmentSecretPrefix(scope.projectId, scope.environmentId)}LATE`;
      await $transaction(prisma, async (tx) => {
        await disabled.assertWrite(tx, [late]);
        await tx.secretStore.create({
          data: {
            key,
            version: "2",
            value: disabled.encrypt(
              late,
              {
                environmentId: scope.environmentId,
                purpose: "environment-variable",
                objectId: key,
              },
              JSON.stringify({ secret: "late" })
            ),
          },
        });
      });
      expect(active.keyId).not.toBeNull();
      expect(
        await repository.getEnvironmentVariables(scope.projectId, scope.environmentId)
      ).toEqual(
        expect.arrayContaining([
          { key: "BEFORE", value: "before" },
          { key: "LATE", value: "late" },
        ])
      );
      expect((await disabled.prepareWrite(scope)).keyId).toBe(active.keyId);
    }
  );

  // Catches: tenant/global enrollment flags bypassing the deployment gate, or an org's explicit false losing to global true.
  postgresTest(
    "enrolls using org then global then false, behind the deployment gate",
    async ({ prisma }) => {
      const flag = FEATURE_FLAG.environmentEncryptionEnabled;
      const cases = [
        { master: false, global: true, org: true, enrolled: false },
        { master: true, global: undefined, org: undefined, enrolled: false },
        { master: true, global: true, org: undefined, enrolled: true },
        { master: true, global: true, org: false, enrolled: false },
        { master: true, global: false, org: true, enrolled: true },
      ];
      for (const testCase of cases) {
        if (testCase.global === undefined) {
          await prisma.featureFlag.deleteMany({ where: { key: flag } });
        } else {
          await prisma.featureFlag.upsert({
            where: { key: flag },
            create: { key: flag, value: testCase.global },
            update: { value: testCase.global },
          });
        }
        const { scope } = await seed(
          prisma,
          testCase.org === undefined ? {} : { [flag]: testCase.org }
        );
        const encryption = service(prisma, { writesEnabled: testCase.master });
        const prepared = await encryption.prepareWrite(scope);
        const context = {
          environmentId: scope.environmentId,
          purpose: "build-env-vars" as const,
          objectId: "deployment",
        };
        const value = encryption.encrypt(prepared, context, "secret");
        expect(!!value.scheme, JSON.stringify(testCase)).toBe(testCase.enrolled);
        expect(
          await encryption.decryptMany([{ projectId: scope.projectId, context, value }])
        ).toEqual(["secret"]);
      }
    }
  );

  // Catches: disabling rollout flags downgrading existing writes to legacy encryption or making existing ciphertext unreadable.
  postgresTest(
    "keeps enrolled environments encrypted after all rollout gates are disabled",
    async ({ prisma }) => {
      const { scope, organization } = await seed(prisma);
      const encryption = service(prisma);
      const first = await encryption.prepareWrite(scope);
      expect(first.keyId).not.toBeNull();
      const context = {
        environmentId: scope.environmentId,
        purpose: "environment-variable" as const,
        objectId: "secret",
      };
      const oldValue = encryption.encrypt(first, context, "old");
      await prisma.organization.update({
        where: { id: organization.id },
        data: { featureFlags: { [FEATURE_FLAG.environmentEncryptionEnabled]: false } },
      });
      await prisma.featureFlag.upsert({
        where: { key: FEATURE_FLAG.environmentEncryptionEnabled },
        create: { key: FEATURE_FLAG.environmentEncryptionEnabled, value: false },
        update: { value: false },
      });
      for (const writesEnabled of [true, false]) {
        const writer = service(prisma, { writesEnabled });
        const next = await writer.prepareWrite(scope);
        expect(next.keyId).toBe(first.keyId);
        const newValue = writer.encrypt(next, context, "new");
        expect(
          await writer.decryptMany(
            [oldValue, newValue].map((value) => ({ projectId: scope.projectId, context, value }))
          )
        ).toEqual(["old", "new"]);
      }
    }
  );

  // Catches: disabled writes creating policy rows, or later defaults overriding an initialized policy.
  postgresTest(
    "chooses wrapping only on first key creation and retains that choice",
    async ({ prisma }) => {
      const { scope } = await seed(prisma);
      const keys = new Map([
        ["a", "a".repeat(32)],
        ["b", "b".repeat(32)],
      ]);
      const disabled = service(prisma, {
        keyring: { activeKeyId: "a", keys },
        writesEnabled: false,
      });
      const legacy = await disabled.prepareWrite(scope);
      expect(legacy.keyId).toBeNull();
      expect(
        await prisma.environmentEncryptionPolicy.count({
          where: { environmentId: scope.environmentId },
        })
      ).toBe(0);
      const enabled = service(prisma, { keyring: { activeKeyId: "b", keys } });
      await enabled.prepareWrite(scope);
      const changedDefault = service(prisma, { keyring: { activeKeyId: "a", keys } });
      await changedDefault.rotate(scope);
      const policy = await prisma.environmentEncryptionPolicy.findFirstOrThrow({
        where: { environmentId: scope.environmentId },
      });
      expect(policy.wrappingKeyReference).toBe("b");
      const reader = service(prisma, {
        keyring: { activeKeyId: "b", keys: new Map([["b", keys.get("b")!]]) },
      });
      const prepared = await reader.prepareWrite(scope);
      const context = {
        environmentId: scope.environmentId,
        purpose: "environment-variable" as const,
        objectId: "secret",
      };
      const value = reader.encrypt(prepared, context, "protected");
      expect(await reader.decryptMany([{ projectId: scope.projectId, context, value }])).toEqual([
        "protected",
      ]);
    }
  );

  // Catches: recovery rotation requiring the old key's plaintext or creating an unnecessary initial key under the default.
  postgresTest(
    "rotates to a healthy wrapping key without access to the old key",
    async ({ prisma }) => {
      const { scope } = await seed(prisma);
      const original = service(prisma);
      const first = await original.prepareWrite(scope);
      const context = {
        environmentId: scope.environmentId,
        purpose: "environment-variable" as const,
        objectId: "secret",
      };
      const oldValue = original.encrypt(first, context, "old");
      const replacementKeys = {
        activeKeyId: "replacement",
        keys: new Map([["replacement", "b".repeat(32)]]),
      };
      const recovery = service(prisma, { keyring: replacementKeys });
      const target = {
        wrappingProvider: "PLATFORM_KEYRING" as const,
        wrappingKeyReference: "replacement",
      };
      await recovery.rotate(scope, target);
      const next = await recovery.prepareWrite(scope);
      const newValue = recovery.encrypt(next, context, "new");
      expect(
        await recovery.decryptMany([{ projectId: scope.projectId, context, value: newValue }])
      ).toEqual(["new"]);
      await expect(
        recovery.decryptMany([{ projectId: scope.projectId, context, value: oldValue }])
      ).rejects.toThrow("unavailable");
      expect(
        await prisma.environmentEncryptionKey.count({
          where: { environmentId: scope.environmentId },
        })
      ).toBe(2);
      expect(
        await prisma.environmentEncryptionKey.findFirst({ where: { id: first.keyId! } })
      ).not.toBeNull();

      const other = await seed(prisma);
      const withoutDefault = new EnvironmentEncryptionService({
        db: prisma,
        transaction: (fn) => $transaction(prisma, fn),
        keyring: replacementKeys,
        writesEnabled: true,
        defaultWrappingPolicy: { ...target, wrappingKeyReference: "unavailable" },
      });
      await withoutDefault.rotate(other.scope, target);
      expect((await withoutDefault.prepareWrite(other.scope)).keyId).not.toBeNull();
      expect(
        await prisma.environmentEncryptionKey.count({
          where: { environmentId: other.environment.id },
        })
      ).toBe(1);
    }
  );

  // Catches: a migration overwriting a value edited after its read, including edits within the same timestamp resolution.
  postgresTest("preserves concurrent edits during migration and can resume", async ({ prisma }) => {
    const { scope } = await seed(prisma);
    const key = `${environmentSecretPrefix(scope.projectId, scope.environmentId)}RACE`;
    const original = await prisma.secretStore.create({
      data: { key, value: { secret: "original" }, version: "1" },
    });
    const encryption = service(prisma);
    let edit = true;
    const migration = {
      db: prisma,
      encryption,
      ...scope,
      apply: true,
      pauseMs: 0,
      encryptionTransaction: async <T>(fn: (tx: PrismaTransactionClient) => Promise<T>) => {
        if (edit) {
          edit = false;
          await prisma.secretStore.update({
            where: { key },
            data: { value: { secret: "concurrent" }, updatedAt: original.updatedAt },
          });
        }
        return $transaction(prisma, fn);
      },
    };
    expect((await migrateEnvironmentEncryption(migration)).conflicts).toBe(1);
    expect((await migrateEnvironmentEncryption(migration)).rewritten).toBe(1);
    const row = await prisma.secretStore.findFirstOrThrow({ where: { key } });
    const plaintext = await encryption.decryptMany([
      {
        projectId: scope.projectId,
        value: row.value,
        context: {
          environmentId: scope.environmentId,
          purpose: "environment-variable",
          objectId: key,
        },
      },
    ]);
    expect(JSON.parse(plaintext[0]!)).toEqual({ secret: "concurrent" });
  });

  // Catches: moving a valid ciphertext to another object or purpose without authentication failure.
  it("authenticates object identity, purpose, key selection and scheme", () => {
    const key = randomBytes(32);
    const context = {
      environmentId: "env",
      purpose: "environment-variable" as const,
      objectId: "secret:a",
    };
    const value = encryptEnvironmentValue("secret", "key-a", key, context);
    expect(decryptEnvironmentValue(value, key, context)).toBe("secret");
    expect(() =>
      decryptEnvironmentValue(value, key, { ...context, objectId: "secret:b" })
    ).toThrow();
    expect(() =>
      decryptEnvironmentValue(value, key, { ...context, purpose: "build-env-vars" })
    ).toThrow();
    expect(() => decryptEnvironmentValue({ ...value, keyId: "key-b" }, key, context)).toThrow();
    expect(() => StoredEnvironmentValueSchema.parse({ ...value, scheme: "unknown" })).toThrow();
    expect(() =>
      parseStoredEnvironmentValue(encryptValue("legacy", keyring), ENVIRONMENT_SECRET_VERSION)
    ).toThrow();
    expect(() => parseStoredEnvironmentValue(value, "2")).toThrow();
  });

  // Catches: concurrent first writes creating competing active keys, and bulk cold reads unwrapping per value.
  postgresTest("initializes once and coalesces cold bulk decryptions", async ({ prisma }) => {
    const { scope } = await seed(prisma);
    const encryption = service(prisma);
    let unwraps = 0;
    const reader = service(prisma, { onUnwrap: () => unwraps++ });
    await reader.decryptMany([
      {
        projectId: scope.projectId,
        context: {
          environmentId: scope.environmentId,
          purpose: "environment-variable",
          objectId: "legacy",
        },
        value: encryptValue("legacy", keyring),
      },
    ]);
    const prepared = await Promise.all(
      Array.from({ length: 8 }, () => encryption.prepareWrite(scope))
    );
    expect(new Set(prepared.map((value) => value.keyId)).size).toBe(1);
    expect(
      await prisma.environmentEncryptionKey.count({ where: { environmentId: scope.environmentId } })
    ).toBe(1);
    const items = Array.from({ length: 50 }, (_, i) => {
      const context = {
        environmentId: scope.environmentId,
        purpose: "environment-variable" as const,
        objectId: `secret:${i}`,
      };
      return {
        projectId: scope.projectId,
        context,
        value: encryption.encrypt(prepared[0]!, context, `value-${i}`),
      };
    });
    const results = await Promise.all(Array.from({ length: 8 }, () => reader.decryptMany(items)));
    expect(results.every((result) => result[49] === "value-49")).toBe(true);
    expect(unwraps).toBe(1);
    await expect(
      reader.decryptMany([
        { ...items[0]!, context: { ...items[0]!.context, environmentId: "other" } },
      ])
    ).rejects.toThrow();
  });

  // Catches: a policy revision forcing warm platform keys to unwrap again during a wrapping-key outage.
  postgresTest("keeps cached platform keys usable across policy revisions", async ({ prisma }) => {
    const { scope } = await seed(prisma);
    const keys = new Map([["platform", "p".repeat(32)]]);
    let unwraps = 0;
    const encryption = service(prisma, {
      keyring: { activeKeyId: "platform", keys },
      onUnwrap: () => unwraps++,
    });
    const repository = new EnvironmentVariablesRepository(prisma, prisma, encryption);
    const write = (value: string) =>
      repository.create(scope.projectId, {
        override: true,
        environmentIds: [scope.environmentId],
        variables: [{ key: "TOKEN", value }],
      });
    expect(await write("before")).toEqual({ success: true });
    await prisma.environmentEncryptionPolicy.update({
      where: { environmentId: scope.environmentId },
      data: { revision: { increment: 1 } },
    });
    await encryption.policies([scope], true);
    keys.clear();
    expect(await repository.getEnvironmentVariables(scope.projectId, scope.environmentId)).toEqual([
      { key: "TOKEN", value: "before" },
    ]);
    expect(await write("after")).toEqual({ success: true });
    expect(await repository.getEnvironmentVariables(scope.projectId, scope.environmentId)).toEqual([
      { key: "TOKEN", value: "after" },
    ]);
    expect(unwraps).toBe(1);
  });

  // Catches: a replica missing a newly rotated key returning an error instead of fetching the writer's record.
  postgresTest("refreshes missing key records from the writer", async ({ prisma }) => {
    const { scope } = await seed(prisma);
    const writer = service(prisma);
    await writer.prepareWrite(scope);
    await $transaction(
      prisma,
      async (replica) => {
        await replica.environmentEncryptionKey.findMany();
        await writer.rotate(scope);
        const prepared = await writer.prepareWrite(scope);
        const context = {
          environmentId: scope.environmentId,
          purpose: "environment-variable" as const,
          objectId: "secret",
        };
        const value = writer.encrypt(prepared, context, "rotated");
        expect(
          await replica.environmentEncryptionKey.findMany({ where: { id: prepared.keyId! } })
        ).toEqual([]);
        const reader = service(prisma);
        const item = { projectId: scope.projectId, context, value };
        expect(await reader.decryptMany([item], replica)).toEqual(["rotated"]);
        await expect(
          reader.decryptMany([{ ...item, value: { ...value, keyId: "missing-key" } }], replica)
        ).rejects.toBeInstanceOf(EnvironmentKeyUnavailableError);
      },
      () => {},
      { isolationLevel: "RepeatableRead", timeout: 30_000 }
    );
  });

  // Catches: key rotation accepting ciphertext prepared before the active-write policy changed.
  postgresTest("fences stale writes while retaining old-key reads", async ({ prisma }) => {
    const { scope } = await seed(prisma);
    const encryption = service(prisma);
    const old = await encryption.prepareWrite(scope);
    const context = {
      environmentId: scope.environmentId,
      purpose: "environment-variable" as const,
      objectId: "secret",
    };
    const value = encryption.encrypt(old, context, "original");
    await encryption.rotate(scope);
    await expect($transaction(prisma, (tx) => encryption.assertWrite(tx, [old]))).rejects.toThrow(
      "policy changed"
    );
    expect(await encryption.decryptMany([{ projectId: scope.projectId, context, value }])).toEqual([
      "original",
    ]);
  });

  // Catches: inherited env vars being decrypted with the child's identity instead of their owning parent's identity.
  postgresTest(
    "reads inherited values and child overrides through the real repository",
    async ({ prisma }) => {
      const { project, organization, environment } = await seed(prisma);
      const child = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PREVIEW",
      });
      await prisma.runtimeEnvironment.update({
        where: { id: child.id },
        data: { parentEnvironmentId: environment.id },
      });
      const repository = new EnvironmentVariablesRepository(prisma, prisma, service(prisma));
      expect(
        await repository.create(project.id, {
          override: true,
          environmentIds: [environment.id],
          variables: [
            { key: "INHERITED", value: "parent" },
            { key: "OVERRIDE", value: "parent" },
          ],
        })
      ).toEqual({ success: true });
      expect(
        await repository.create(project.id, {
          override: true,
          environmentIds: [child.id],
          variables: [{ key: "OVERRIDE", value: "child" }],
        })
      ).toEqual({ success: true });
      const values = await repository.getEnvironmentVariables(project.id, child.id, environment.id);
      expect(new Map(values.map((value) => [value.key, value.value]))).toEqual(
        new Map([
          ["INHERITED", "parent"],
          ["OVERRIDE", "child"],
        ])
      );
      const stored = await prisma.secretStore.findFirstOrThrow({
        where: { key: `${environmentSecretPrefix(project.id, child.id)}OVERRIDE` },
      });
      expect(stored.version).toBe(ENVIRONMENT_SECRET_VERSION);
    }
  );

  // Catches: migration missing plaintext/legacy values or build envelopes, and redeploy retaining a source object's AAD.
  postgresTest(
    "migrates both storage locations and re-encrypts redeploys for their destination",
    async ({ prisma }) => {
      const { project, scope } = await seed(prisma);
      const prefix = environmentSecretPrefix(project.id, scope.environmentId);
      await prisma.secretStore.createMany({
        data: [
          { key: `${prefix}PLAIN`, version: "1", value: { secret: "plain" } },
          {
            key: `${prefix}OLD`,
            version: "2",
            value: encryptValue(JSON.stringify({ secret: "old" }), keyring),
          },
        ],
      });
      const source = await prisma.workerDeployment.create({
        data: {
          projectId: project.id,
          environmentId: scope.environmentId,
          version: "v1",
          shortCode: "source",
          friendlyId: "deployment_source",
          contentHash: "hash",
          buildEnvVars: encryptValue(JSON.stringify({ TOKEN: "build-secret" }), keyring),
        },
      });
      const encryption = service(prisma);
      const migration = {
        db: prisma,
        encryption,
        encryptionTransaction: <T>(fn: Parameters<typeof $transaction<T>>[1]) =>
          $transaction(prisma, fn),
        ...scope,
        pauseMs: 0,
      };
      expect((await migrateEnvironmentEncryption({ ...migration, apply: true })).rewritten).toBe(3);
      expect((await migrateEnvironmentEncryption({ ...migration, apply: true })).rewritten).toBe(0);
      const migrated = await prisma.workerDeployment.findFirstOrThrow({ where: { id: source.id } });
      const prepared = await encryption.prepareWrite(scope);
      const destinationContext = {
        environmentId: scope.environmentId,
        purpose: "build-env-vars" as const,
        objectId: "destination",
      };
      const envelope = await buildEnvVarsEnvelope(
        { isNativeBuild: true, fromBundle: true } as Parameters<typeof buildEnvVarsEnvelope>[0],
        {
          copyFrom: StoredEnvironmentValueSchema.parse(migrated.buildEnvVars),
          maxKeys: 10,
          maxBytes: 1_000,
          encrypt: (plaintext) => encryption.encrypt(prepared, destinationContext, plaintext),
          decryptSource: async (value) =>
            (
              await encryption.decryptMany([
                {
                  projectId: project.id,
                  value,
                  context: { ...destinationContext, objectId: source.id },
                },
              ])
            )[0]!,
        }
      );
      const item = { projectId: project.id, context: destinationContext, value: envelope };
      expect(JSON.parse((await encryption.decryptMany([item]))[0]!)).toEqual({
        TOKEN: "build-secret",
      });
      await expect(
        encryption.decryptMany([
          { ...item, context: { ...destinationContext, objectId: source.id } },
        ])
      ).rejects.toThrow();
      expect(
        await encryption.decryptMany([
          {
            projectId: project.id,
            context: destinationContext,
            value: encryptValue("legacy", keyring),
          },
        ])
      ).toEqual(["legacy"]);
    }
  );
});
