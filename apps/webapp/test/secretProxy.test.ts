import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decodeJwt } from "jose";
import { postgresTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { sandboxExecutionPolicy } from "@trigger.dev/core/v3";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { $transaction } from "~/db.server";
import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import { metrics } from "@opentelemetry/api";
import { createInMemoryMetrics } from "./utils/tracing";
import { EnvironmentEncryptionService } from "~/services/environmentEncryption/service.server";
import {
  EnvironmentSecretStore,
  environmentSecretPrefix,
} from "~/services/environmentEncryption/secretStore.server";
import { generateRs256KeyPair, importRs256PrivateKey, signRs256Jwt } from "~/services/oidc/crypto";
import { RUN_TOKEN_AUDIENCE, RUN_TOKEN_TYPE, RUN_TOKEN_USE } from "~/services/oidc/runTokenClaims";
import {
  parsePlaceholderKeyring,
  configuredPlaceholderKeyring,
  placeholderForVariable,
  SECRET_PROXY_MAX_RESPONSE_BYTES,
  SECRET_PROXY_MAX_CREDENTIAL_BYTES,
} from "~/services/secretProxy/placeholder.server";
import { resolveSecretProxyRequest } from "~/services/secretProxy/resolveAction.server";
import { SecretProxyService, SecretProxyDeniedError } from "~/services/secretProxy/service.server";
import {
  assertVariablesNotProxyOnly,
  effectiveEnvironmentVariables,
} from "~/services/secretProxy/variables.server";
import { resolveEncryptionKeyring } from "~/utils/encryptionKeyring.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { z } from "zod";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
  enrollProxyOnlyValue,
} from "./fixtures/environmentVariablesFixtures";

const telemetry = createInMemoryMetrics();
beforeAll(() => {
  metrics.disable();
  metrics.setGlobalMeterProvider(telemetry.meterProvider);
});
afterAll(async () => {
  await telemetry.shutdown();
  metrics.disable();
});

const issuer = "https://runs.example.com";
const serviceToken = "resolver-service-token-" + "x".repeat(32);
const placeholderKeys = parsePlaceholderKeyring(
  JSON.stringify({
    activeKeyId: "current",
    keys: { current: randomBytes(32).toString("hex"), retained: randomBytes(32).toString("hex") },
  })
);

async function seed(db: PrismaClient) {
  const data = await createTestOrgProjectWithMember(db);
  await db.organization.update({
    where: { id: data.organization.id },
    data: {
      featureFlags: {
        [FEATURE_FLAG.runTokenInjection]: true,
        [FEATURE_FLAG.environmentEncryptionEnabled]: true,
      },
    },
  });
  const environment = await createRuntimeEnvironment(db, {
    projectId: data.project.id,
    organizationId: data.organization.id,
    type: "PRODUCTION",
  });
  const keyring = resolveEncryptionKeyring(undefined, "0123456789abcdef0123456789abcdef");
  const encryption = new EnvironmentEncryptionService({
    db,
    transaction: (fn) => $transaction(db, fn),
    keyring,
    writesEnabled: true,
    defaultWrappingPolicy: {
      wrappingProvider: "PLATFORM_KEYRING",
      wrappingKeyReference: keyring.activeKeyId,
    },
  });
  await encryption.rotate({ projectId: data.project.id, environmentId: environment.id });
  const id = RunId.generate();
  const run = await db.taskRun.create({
    data: {
      id: id.id,
      friendlyId: id.friendlyId,
      taskIdentifier: "secret-proxy",
      payload: "{}",
      traceId: randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      queue: "task/secret-proxy",
      runtimeEnvironmentId: environment.id,
      projectId: data.project.id,
      organizationId: data.organization.id,
      engine: "V2",
      status: "EXECUTING",
      attemptNumber: 1,
    },
  });
  const key = await generateRs256KeyPair();
  const privateKey = await importRs256PrivateKey(key.privateKeyPkcs8);
  const store = new PostgresRunStore({ prisma: db, readOnlyPrisma: db });
  const options = {
    db,
    encryption,
    keyring: placeholderKeys,
    serviceToken,
    issuer,
    publicJwks: async () => ({ keys: [key.publicJwk] }),
    findRun: (id: string, runtimeEnvironmentId: string, projectId: string) =>
      store.findRun(
        { id, runtimeEnvironmentId, projectId },
        {
          select: {
            friendlyId: true,
            runtimeEnvironmentId: true,
            projectId: true,
            organizationId: true,
            attemptNumber: true,
            status: true,
            annotations: true,
          },
        }
      ),
  };
  const service = new SecretProxyService({ ...options, enabled: true });
  async function sign(overrides: Record<string, unknown> = {}, expiresInSeconds = 900) {
    return signRs256Jwt({
      payload: {
        token_use: RUN_TOKEN_USE,
        run_id: run.friendlyId,
        attempt: 1,
        org_id: data.organization.id,
        project_id: data.project.id,
        environment_id: environment.id,
        scopes: ["admin"],
        ...overrides,
      },
      privateKey,
      kid: key.kid,
      issuer,
      audience: RUN_TOKEN_AUDIENCE,
      subject: `run:${run.friendlyId}`,
      typ: RUN_TOKEN_TYPE,
      expiresInSeconds,
    });
  }
  async function variable(name: string, value: string, environmentId = environment.id) {
    const variable = await db.environmentVariable.upsert({
      where: { projectId_key: { projectId: data.project.id, key: name } },
      create: { projectId: data.project.id, key: name, friendlyId: uniqueId("envvar") },
      update: {},
    });
    const prepared = await encryption.prepareWrite({ projectId: data.project.id, environmentId });
    const secrets = new EnvironmentSecretStore(
      db,
      encryption,
      data.project.id,
      [environmentId],
      new Map([[environmentId, prepared]])
    );
    const secretKey = `${environmentSecretPrefix(data.project.id, environmentId)}${name}`;
    await secrets.setSecret(secretKey, { secret: value });
    const reference = await db.secretReference.create({
      data: { key: secretKey, provider: "DATABASE" },
    });
    const record = await db.environmentVariableValue.create({
      data: {
        variableId: variable.id,
        environmentId,
        valueReferenceId: reference.id,
      },
    });
    return { variable, record, secretKey };
  }
  return { ...data, environment, encryption, run, service, options, sign, variable };
}

const requestFor = (handle: string, hostname = "api.example.com") => ({
  bindingId: "allocation-1",
  resolve: [{ handle, hostname, port: 443 }],
});

describe("secret proxy integration", () => {
  postgresTest("restricts policy runs to their granted variables", async ({ prisma }) => {
    const f = await seed(prisma);
    const granted = await f.variable("GRANTED", "granted-value");
    const other = await f.variable("OTHER", "other-value");
    for (const { variable } of [granted, other]) {
      await enrollProxyOnlyValue(prisma, {
        environmentId: f.environment.id,
        variableId: variable.id,
        allowedHosts: ["api.example.com"],
      });
    }
    await prisma.taskRun.update({
      where: { id: f.run.id },
      data: {
        annotations: {
          triggerSource: "api",
          triggerAction: "trigger",
          rootTriggerSource: "api",
          executionMode: "SANDBOX",
          executionPolicy: sandboxExecutionPolicy({ envVars: ["GRANTED"] }),
        },
      },
    });
    const token = await f.sign({ scopes: [`read:runs:${f.run.friendlyId}`] });
    const handleFor = (variableId: string) =>
      placeholderForVariable(placeholderKeys, { runId: f.run.friendlyId, attempt: 1 }, variableId);

    const resolved = await f.service.resolve(
      serviceToken,
      token,
      requestFor(handleFor(granted.variable.id))
    );
    expect(resolved.credentials[0]!.value).toBe("granted-value");
    await expect(
      f.service.resolve(serviceToken, token, requestFor(handleFor(other.variable.id)))
    ).rejects.toBeInstanceOf(SecretProxyDeniedError);
  });

  postgresTest(
    "captures a consistent grant snapshot and commits before key loading",
    async ({ prisma }) => {
      const migration = await readFile(
        new URL(
          "../../../internal-packages/database/prisma/migrations/20261110160000_secret_proxy_protected_variables_index/migration.sql",
          import.meta.url
        ),
        "utf8"
      );
      await prisma.$executeRawUnsafe(migration);
      const f = await seed(prisma);
      const secret = await f.variable("TOKEN", "original");
      await enrollProxyOnlyValue(prisma, {
        environmentId: f.environment.id,
        variableId: secret.variable.id,
        allowedHosts: ["api.example.com"],
      });
      const prepared = await f.encryption.prepareWrite({
        projectId: f.project.id,
        environmentId: f.environment.id,
      });
      const rotated = f.encryption.encrypt(
        prepared,
        {
          environmentId: f.environment.id,
          purpose: "environment-variable",
          objectId: secret.secretKey,
        },
        JSON.stringify({ secret: "rotated" })
      );
      let didRotate = false;
      const db = prisma.$extends({
        query: {
          async $allOperations({ operation, args, query }) {
            const result = await query(args);
            if (
              operation === "$queryRaw" &&
              !didRotate &&
              Array.isArray(result) &&
              result.some(
                (row) => typeof row === "object" && row !== null && "encryptedValue" in row
              )
            ) {
              didRotate = true;
              await $transaction(prisma, async (tx) => {
                await tx.environmentVariableValue.update({
                  where: { id: secret.record.id },
                  data: {
                    proxyConfig: { allowedHosts: ["new.example.com"] },
                    version: { increment: 1 },
                  },
                });
                await tx.secretStore.update({
                  where: { key: secret.secretKey },
                  data: { value: rotated },
                });
              });
            }
            return result;
          },
        },
      }) as unknown as PrismaClient;
      const keyring = resolveEncryptionKeyring(undefined, "0123456789abcdef0123456789abcdef");
      const encryption = new EnvironmentEncryptionService({
        db: prisma,
        transaction: (fn) => $transaction(prisma, fn),
        keyring,
        writesEnabled: true,
        defaultWrappingPolicy: {
          wrappingProvider: "PLATFORM_KEYRING",
          wrappingKeyReference: keyring.activeKeyId,
        },
      });
      const service = new SecretProxyService({ ...f.options, db, encryption, enabled: true });
      const token = await f.sign();
      const handle = placeholderForVariable(
        placeholderKeys,
        { runId: f.run.friendlyId, attempt: 1 },
        secret.variable.id
      );
      let locked!: () => void;
      const lockReady = new Promise<void>((resolve) => (locked = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const blocker = $transaction(prisma, async (tx) => {
        await tx.$executeRaw`LOCK TABLE "EnvironmentEncryptionKey" IN ACCESS EXCLUSIVE MODE`;
        locked();
        await released;
      });
      await lockReady;
      const resolving = service.resolve(serviceToken, token, requestFor(handle));
      try {
        await vi.waitFor(async () => {
          const waiting = await prisma.$queryRaw<
            unknown[]
          >`SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%"EnvironmentEncryptionKey"%'`;
          expect(waiting).toHaveLength(1);
        });
        await $transaction(prisma, async (tx) => {
          await tx.$executeRaw`LOCK TABLE "EnvironmentVariableValue" IN ACCESS EXCLUSIVE MODE NOWAIT`;
        });
      } finally {
        release();
        await blocker;
      }
      const result = await resolving;
      expect(result.credentials).toEqual([
        { handle, hostname: "api.example.com", value: "original" },
      ]);
      await expect(service.resolve(serviceToken, token, requestFor(handle))).rejects.toThrow(
        "not authorized"
      );
      expect(
        (await service.resolve(serviceToken, token, requestFor(handle, "new.example.com")))
          .credentials
      ).toEqual([{ handle, hostname: "new.example.com", value: "rotated" }]);
    }
  );
  postgresTest(
    "starts the plaintext TTL before I/O and allows fresh decryption after expiry",
    { timeout: 60_000 },
    async ({ prisma }) => {
      const f = await seed(prisma);
      const secret = await f.variable("TOKEN", "credential");
      await enrollProxyOnlyValue(prisma, {
        environmentId: f.environment.id,
        variableId: secret.variable.id,
        allowedHosts: ["api.example.com"],
      });
      const token = await f.sign();
      const handle = placeholderForVariable(
        placeholderKeys,
        { runId: f.run.friendlyId, attempt: 1 },
        secret.variable.id
      );
      let locked!: () => void;
      const lockReady = new Promise<void>((resolve) => (locked = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const blocker = $transaction(prisma, async (tx) => {
        await tx.$executeRaw`LOCK TABLE "TaskRun" IN ACCESS EXCLUSIVE MODE`;
        locked();
        await released;
      });
      await lockReady;
      let first: Awaited<ReturnType<SecretProxyService["resolve"]>>;
      try {
        const resolving = f.service.resolve(serviceToken, token, requestFor(handle));
        const enteredAt = Date.now();
        await prisma.$queryRaw`SELECT 1 FROM pg_sleep(0.1)`;
        release();
        first = await resolving;
        expect(first.expiresAtMs).toBeLessThanOrEqual(enteredAt + 30_000);
        expect(first.expiresAtMs).toBeGreaterThan(Date.now());
      } finally {
        release();
        await blocker;
      }
      await prisma.$queryRaw`SELECT 1 FROM pg_sleep(30.05)`;
      expect(first.expiresAtMs).toBeLessThan(Date.now());
      const fresh = await f.service.resolve(serviceToken, token, requestFor(handle));
      expect(fresh.credentials[0]!.value).toBe("credential");
      expect(fresh.expiresAtMs).toBeGreaterThan(Date.now());
      expect(fresh.expiresAtMs).toBeLessThanOrEqual(Date.now() + 30_000);
    }
  );
  postgresTest(
    "returns requested grants only and bounds effective variables and execution hosts",
    async ({ prisma }) => {
      const f = await seed(prisma);
      const secret = await f.variable("TOKEN", "credential");
      const hosts = Array.from({ length: 64 }, (_, i) => `${i}.api.example.com`);
      await enrollProxyOnlyValue(prisma, {
        environmentId: f.environment.id,
        variableId: secret.variable.id,
        allowedHosts: hosts,
      });
      const variables = Array.from({ length: 511 }, (_, i) => ({
        id: `limit-variable-${i.toString().padStart(4, "0")}`,
        friendlyId: uniqueId("envvar"),
        key: `TOKEN_${i}`,
        projectId: f.project.id,
      }));
      await prisma.environmentVariable.createMany({ data: variables });
      // The other protected values deliberately have no ciphertext.
      await prisma.environmentVariableValue.createMany({
        data: variables.map((variable) => ({
          variableId: variable.id,
          environmentId: f.environment.id,
          isProxyOnly: true,
          isSecret: true,
          proxyConfig: { allowedHosts: hosts },
        })),
      });
      const rotatedKeys = parsePlaceholderKeyring(
        JSON.stringify({
          activeKeyId: "k".repeat(32),
          keys: Object.fromEntries(
            Array.from({ length: 8 }, (_, i) => [
              i === 0 ? "k".repeat(32) : `retained-${i}`,
              randomBytes(32).toString("hex"),
            ])
          ),
        })
      );
      const service = new SecretProxyService({ ...f.options, enabled: true, keyring: rotatedKeys });
      const token = await f.sign();
      const metadata = await effectiveEnvironmentVariables(prisma, f.project.id, f.environment.id);
      const allowedHosts = await service.preflightRuntime(
        f.project.id,
        f.environment.id,
        metadata,
        true,
        true
      );
      expect(allowedHosts).toEqual(hosts);
      const handle = placeholderForVariable(
        rotatedKeys,
        { runId: f.run.friendlyId, attempt: 1 },
        secret.variable.id,
        "retained-7"
      );
      const response = await service.resolve(serviceToken, token, requestFor(handle, hosts[0]!));
      expect(response).toEqual({
        runId: f.run.friendlyId,
        attempt: 1,
        expiresAtMs: expect.any(Number),
        credentials: [{ handle, hostname: hosts[0], value: "credential" }],
      });
      for (let i = 0; i < 4; i++) {
        await prisma.environmentVariableValue.updateMany({
          where: { variableId: variables[i]!.id },
          data: { proxyConfig: { allowedHosts: hosts.map((host) => `group${i}.${host}`) } },
        });
      }
      await expect(
        service.preflightRuntime(
          f.project.id,
          f.environment.id,
          await effectiveEnvironmentVariables(prisma, f.project.id, f.environment.id),
          true,
          true
        )
      ).rejects.toThrow("Too many secret proxy destinations");
      const extra = await prisma.environmentVariable.create({
        data: { projectId: f.project.id, key: "EXTRA", friendlyId: uniqueId("envvar") },
      });
      await prisma.environmentVariableValue.create({
        data: {
          variableId: extra.id,
          environmentId: f.environment.id,
          isProxyOnly: true,
          proxyConfig: { allowedHosts: hosts },
        },
      });
      await expect(
        service.resolve(serviceToken, token, requestFor(handle, hosts[0]!))
      ).rejects.toThrow("Too many secret proxy variables");
    }
  );

  postgresTest(
    "bounds aggregate credential UTF-8 bytes, not string or escaped JSON length",
    async ({ prisma }) => {
      const f = await seed(prisma);
      const escaped = '\\"\u0001😀'.repeat(9362) + "xx";
      expect(Buffer.byteLength(escaped)).toBe(SECRET_PROXY_MAX_CREDENTIAL_BYTES);
      const first = await f.variable("FIRST", escaped);
      const second = await f.variable("SECOND", "x");
      for (const value of [first, second]) {
        await enrollProxyOnlyValue(prisma, {
          environmentId: f.environment.id,
          variableId: value.variable.id,
          allowedHosts: ["api.example.com"],
        });
      }
      const token = await f.sign();
      const handles = [first, second].map((value) =>
        placeholderForVariable(
          placeholderKeys,
          { runId: f.run.friendlyId, attempt: 1 },
          value.variable.id
        )
      );
      const response = await f.service.resolve(serviceToken, token, requestFor(handles[0]!));
      expect(response.credentials[0]!.value).toBe(escaped);
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(
        SECRET_PROXY_MAX_RESPONSE_BYTES
      );
      await expect(
        f.service.resolve(serviceToken, token, {
          bindingId: "allocation-1",
          resolve: handles.map((handle) => ({ handle, hostname: "api.example.com", port: 443 })),
        })
      ).rejects.toThrow("credentials too large");
    }
  );

  postgresTest(
    "resolves only authorized handles against a live run-store attempt",
    async ({ prisma }) => {
      const f = await seed(prisma);
      const secret = await f.variable("API_TOKEN", "secret-one");
      await f.variable("PLAIN", "normal-value");
      await enrollProxyOnlyValue(prisma, {
        environmentId: f.environment.id,
        variableId: secret.variable.id,
        allowedHosts: ["api.example.com"],
      });
      const token = await f.sign();
      const unauthorized = await resolveSecretProxyRequest(
        f.service,
        new Request("https://platform.example.com/engine/v1/secret-proxy/resolve", {
          method: "POST",
          body: "not json",
        })
      );
      expect(unauthorized.status).toBe(401);
      const oversized = await resolveSecretProxyRequest(
        f.service,
        new Request("https://platform.example.com/engine/v1/secret-proxy/resolve", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-trigger-secret-proxy-token": serviceToken,
            authorization: `Bearer ${token}`,
          },
          body: "x".repeat(32_769),
        })
      );
      expect(oversized.status).toBe(413);
      const handle = placeholderForVariable(
        placeholderKeys,
        { runId: f.run.friendlyId, attempt: 1 },
        secret.variable.id
      );
      const snapshot = await f.service.resolve(serviceToken, token, {
        bindingId: "allocation-1",
        resolve: [],
      });
      expect(snapshot).toEqual({
        runId: f.run.friendlyId,
        attempt: 1,
        expiresAtMs: expect.any(Number),
        credentials: [],
      });
      const response = await resolveSecretProxyRequest(
        f.service,
        new Request("https://platform.example.com/engine/v1/secret-proxy/resolve", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-trigger-secret-proxy-token": serviceToken,
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify(requestFor(handle)),
        })
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const exported = (await telemetry.getMetrics()).flatMap((resource) =>
        resource.scopeMetrics.flatMap((scope) =>
          scope.metrics.filter((metric) => metric.descriptor.name === "secret_proxy.failures")
        )
      );
      const failures = exported.flatMap((metric) => metric.dataPoints);
      expect(failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attributes: { operation: "resolve", reason: "service_auth" },
            value: 1,
          }),
          expect.objectContaining({
            attributes: { operation: "resolve", reason: "limit" },
            value: 1,
          }),
        ])
      );
      expect(JSON.stringify(exported)).not.toContain(token);
      expect(JSON.stringify(exported)).not.toContain(handle);
      expect(JSON.stringify(exported)).not.toContain("secret-one");
      const first = await f.service.resolve(serviceToken, token, requestFor(handle));
      expect(first.credentials).toHaveLength(1);
      expect(first.credentials[0]).toMatchObject({
        value: "secret-one",
        handle,
        hostname: "api.example.com",
      });
      expect(first.expiresAtMs).toBeLessThanOrEqual(Date.now() + 30_000);
      const second = await f.service.resolve(serviceToken, token, requestFor(handle));
      expect(second.expiresAtMs).toBeGreaterThanOrEqual(first.expiresAtMs);
      expect(second.expiresAtMs).toBeLessThanOrEqual(Date.now() + 30_000);
      const retained = placeholderForVariable(
        placeholderKeys,
        { runId: f.run.friendlyId, attempt: 1 },
        secret.variable.id,
        "retained"
      );
      expect(
        (await f.service.resolve(serviceToken, token, requestFor(retained))).credentials[0]!.value
      ).toBe("secret-one");
      await expect(
        f.service.resolve("wrong-service", token, requestFor(handle))
      ).rejects.toBeInstanceOf(SecretProxyDeniedError);
      await expect(
        f.service.resolve(serviceToken, token, requestFor(handle, "other.example.com"))
      ).rejects.toBeInstanceOf(SecretProxyDeniedError);
      await expect(
        f.service.resolve(
          serviceToken,
          await f.sign({ run_id: RunId.generate().friendlyId }),
          requestFor(handle)
        )
      ).rejects.toBeInstanceOf(SecretProxyDeniedError);
      await expect(
        f.service.resolve(serviceToken, await f.sign({ attempt: 2 }), requestFor(handle))
      ).rejects.toBeInstanceOf(SecretProxyDeniedError);
      await expect(
        f.service.resolve(
          serviceToken,
          token,
          requestFor(
            placeholderForVariable(
              placeholderKeys,
              { runId: f.run.friendlyId, attempt: 1 },
              (
                await prisma.environmentVariable.findFirstOrThrow({
                  where: { key: "PLAIN", projectId: f.project.id },
                })
              ).id
            )
          )
        )
      ).rejects.toBeInstanceOf(SecretProxyDeniedError);
      const prepared = await f.encryption.prepareWrite({
        projectId: f.project.id,
        environmentId: f.environment.id,
      });
      const rotatedValue = f.encryption.encrypt(
        prepared,
        {
          environmentId: f.environment.id,
          purpose: "environment-variable",
          objectId: secret.secretKey,
        },
        JSON.stringify({ secret: "secret-two" })
      );
      await prisma.secretStore.update({
        where: { key: secret.secretKey },
        data: { value: rotatedValue },
      });
      await prisma.environmentVariableValue.update({
        where: { id: secret.record.id },
        data: { version: { increment: 1 } },
      });
      const rotated = await f.service.resolve(serviceToken, token, requestFor(handle));
      expect(rotated.credentials[0]).toMatchObject({
        handle,
        value: "secret-two",
        hostname: "api.example.com",
      });
      await prisma.taskRun.update({
        where: { id: f.run.id },
        data: { status: "COMPLETED_SUCCESSFULLY" },
      });
      await expect(
        f.service.resolve(serviceToken, token, requestFor(handle))
      ).rejects.toBeInstanceOf(SecretProxyDeniedError);
    }
  );

  postgresTest(
    "value deletion captures concurrent enrollment after taking the identity lock",
    { timeout: 60_000 },
    async ({ prisma }) => {
      const f = await seed(prisma);
      const original = await f.variable("TOKEN", "ordinary");
      const other = await createRuntimeEnvironment(prisma, {
        projectId: f.project.id,
        organizationId: f.organization.id,
        type: "STAGING",
      });
      const key = `${environmentSecretPrefix(f.project.id, other.id)}TOKEN`;
      const prepared = await f.encryption.prepareWrite({
        projectId: f.project.id,
        environmentId: other.id,
      });
      const store = new EnvironmentSecretStore(prisma, f.encryption, f.project.id, [other.id]);
      await new EnvironmentSecretStore(
        prisma,
        f.encryption,
        f.project.id,
        [other.id],
        new Map([[other.id, prepared]])
      ).setSecret(key, { secret: "protected" });
      const reference = await prisma.secretReference.create({
        data: { key, provider: "DATABASE" },
      });
      let ready!: () => void;
      const enrolled = new Promise<void>((resolve) => (ready = resolve));
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      const enrolling = $transaction(
        prisma,
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "EnvironmentVariable" WHERE id = ${original.variable.id} FOR UPDATE`;
          await tx.environmentVariableValue.create({
            data: {
              variableId: original.variable.id,
              environmentId: other.id,
              valueReferenceId: reference.id,
            },
          });
          await enrollProxyOnlyValue(tx, {
            environmentId: other.id,
            variableId: original.variable.id,
            allowedHosts: ["api.example.com"],
          });
          ready();
          await released;
        },
        { timeout: 30_000 }
      );
      await Promise.race([enrolled, enrolling]);
      const repository = new EnvironmentVariablesRepository(prisma, prisma, f.encryption);
      const deleting = repository.deleteValue(f.project.id, {
        id: original.variable.id,
        environmentId: other.id,
      });
      try {
        await vi.waitFor(
          async () => {
            const waiting = await prisma.$queryRaw<unknown[]>`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%"EnvironmentVariable"%' AND query LIKE '%FOR UPDATE%'
          `;
            expect(waiting.length).toBeGreaterThan(0);
          },
          { timeout: 10_000 }
        );
      } finally {
        release();
        await enrolling;
      }
      expect(await deleting).toMatchObject({
        success: false,
        error: expect.stringContaining("Proxy-only"),
      });
      expect(
        await prisma.environmentVariableValue.findFirst({
          where: { variableId: original.variable.id, environmentId: other.id },
        })
      ).toMatchObject({ isProxyOnly: true });
      expect(await prisma.secretStore.findFirst({ where: { key } })).not.toBeNull();
      expect(
        await store.getSecrets(
          z.object({ secret: z.string() }),
          environmentSecretPrefix(f.project.id, other.id)
        )
      ).toEqual([]);
    }
  );

  postgresTest(
    "filters before decryption, inherits policy, and delivers only stateless runtime handles",
    async ({ prisma }) => {
      const f = await seed(prisma);
      const protectedValue = await f.variable("API_TOKEN", "secret-parent");
      const child = await createRuntimeEnvironment(prisma, {
        projectId: f.project.id,
        organizationId: f.organization.id,
        type: "PREVIEW",
      });
      await prisma.runtimeEnvironment.update({
        where: { id: child.id },
        data: { parentEnvironmentId: f.environment.id },
      });
      await f.variable("API_TOKEN", "secret-child", child.id);
      const normal = await f.variable("PLAIN", "normal-value");
      await enrollProxyOnlyValue(prisma, {
        environmentId: f.environment.id,
        variableId: protectedValue.variable.id,
        allowedHosts: ["api.example.com"],
      });
      const childMetadata = await effectiveEnvironmentVariables(prisma, f.project.id, child.id);
      expect(childMetadata.find((value) => value.key === "API_TOKEN")).toMatchObject({
        environmentId: child.id,
        isProxyOnly: true,
        proxyAllowedHosts: ["api.example.com"],
      });
      await enrollProxyOnlyValue(prisma, {
        environmentId: child.id,
        variableId: protectedValue.variable.id,
        allowedHosts: ["api.example.com"],
      });
      await expect(
        assertVariablesNotProxyOnly(prisma, f.project.id, [child.id], ["API_TOKEN"])
      ).rejects.toThrow("operator");
      const metadata = await effectiveEnvironmentVariables(prisma, f.project.id, f.environment.id);
      const token = await f.sign();
      const proxyValues = metadata.filter((value) => value.isProxyOnly);
      const hosts = await f.service.preflightRuntime(
        f.project.id,
        f.environment.id,
        proxyValues,
        true,
        true
      );
      const delivery = f.service.finalizeRuntime(proxyValues, hosts, {
        runId: f.run.friendlyId,
        attempt: 1,
        expiresAtMs: decodeJwt(token).exp! * 1000,
      });
      expect(delivery.placeholders).toEqual([
        {
          key: "API_TOKEN",
          value: placeholderForVariable(
            placeholderKeys,
            { runId: f.run.friendlyId, attempt: 1 },
            protectedValue.variable.id
          ),
        },
      ]);
      expect(delivery.secretProxy).toMatchObject({
        runId: f.run.friendlyId,
        attempt: 1,
        allowedHosts: ["api.example.com"],
      });
      await expect(
        f.service.preflightRuntime(f.project.id, f.environment.id, proxyValues, false, true)
      ).rejects.toBeInstanceOf(SecretProxyDeniedError);
      expect(configuredPlaceholderKeyring(false, "{invalid-json")).toBeUndefined();
      expect(() => configuredPlaceholderKeyring(true, "{invalid-json")).toThrow();
      const disabled = new SecretProxyService({ ...f.options, enabled: false });
      await expect(
        disabled.preflightRuntime(f.project.id, f.environment.id, proxyValues, true, true)
      ).rejects.toBeInstanceOf(SecretProxyDeniedError);
      const disabledDenials = (await telemetry.getMetrics())
        .flatMap((resource) =>
          resource.scopeMetrics.flatMap((scope) =>
            scope.metrics
              .filter((metric) => metric.descriptor.name === "secret_proxy.delivery.requests")
              .flatMap((metric) => metric.dataPoints)
          )
        )
        .filter(
          (point) =>
            point.attributes.phase === "preflight" &&
            point.attributes.enabled === "false" &&
            point.attributes.outcome === "denied"
        )
        .at(-1);
      expect(disabledDenials?.value).toBeGreaterThan(0);
      await expect(
        f.service.preflightRuntime(f.project.id, f.environment.id, proxyValues, true, false)
      ).rejects.toThrow("Worker does not support");
      // Unreadable protected storage must not make a normal export attempt decryption.
      await prisma.secretStore.update({
        where: { key: protectedValue.secretKey },
        data: { value: { invalid: "ciphertext" } },
      });
      const store = new EnvironmentSecretStore(prisma, f.encryption, f.project.id, [
        f.environment.id,
      ]);
      expect(
        await store.getSecrets(
          z.object({ secret: z.string() }),
          environmentSecretPrefix(f.project.id, f.environment.id)
        )
      ).toEqual([{ key: normal.secretKey, value: { secret: "normal-value" } }]);
      const repository = new EnvironmentVariablesRepository(prisma, prisma, f.encryption);
      const preparedVariables = await repository.resolveEnvironmentVariables(
        f.project.id,
        f.environment.id
      );
      expect(preparedVariables.variables).toEqual([{ key: "PLAIN", value: "normal-value" }]);
      expect(preparedVariables.proxyValues).toEqual([metadata.find((value) => value.isProxyOnly)]);
      expect(await repository.getEnvironmentVariables(f.project.id, f.environment.id)).toEqual([
        { key: "PLAIN", value: "normal-value" },
      ]);
      expect(
        await repository.getEnvironmentWithRedactedSecrets(f.project.id, f.environment.id)
      ).toEqual([{ key: "PLAIN", value: "normal-value", isSecret: false }]);
      expect((await repository.getProject(f.project.id)).map((variable) => variable.key)).toEqual([
        "PLAIN",
      ]);
      expect(
        await repository.getVariableValuesForKeys(f.project.id, [
          { environmentId: f.environment.id, key: "API_TOKEN" },
          { environmentId: child.id, key: "API_TOKEN" },
          { environmentId: f.environment.id, key: "PLAIN" },
        ])
      ).toEqual(new Map([[`${f.environment.id}:PLAIN`, "normal-value"]]));
      for (const mutate of [
        () =>
          repository.create(f.project.id, {
            override: true,
            environmentIds: [child.id],
            isSecret: false,
            variables: [{ key: "API_TOKEN", value: "replacement" }],
          }),
        () =>
          repository.edit(f.project.id, {
            id: protectedValue.variable.id,
            values: [{ environmentId: child.id, value: "replacement" }],
          }),
        () =>
          repository.editValue(f.project.id, {
            id: protectedValue.variable.id,
            environmentId: child.id,
            value: "replacement",
          }),
        () =>
          repository.deleteValue(f.project.id, {
            id: protectedValue.variable.id,
            environmentId: child.id,
          }),
      ]) {
        expect((await mutate()).success).toBe(false);
      }
      const prepared = await f.encryption.prepareWrite({
        projectId: f.project.id,
        environmentId: f.environment.id,
      });
      const writer = new EnvironmentSecretStore(
        prisma,
        f.encryption,
        f.project.id,
        [f.environment.id],
        new Map([[f.environment.id, prepared]])
      );
      await expect(
        writer.setSecret(protectedValue.secretKey, { secret: "replacement" })
      ).rejects.toThrow("operator");
      await expect(writer.deleteSecret(protectedValue.secretKey)).rejects.toThrow("operator");
      await f.variable("CHILD_TOKEN", "ordinary-parent");
      const childOnly = await f.variable("CHILD_TOKEN", "protected-child", child.id);
      await enrollProxyOnlyValue(prisma, {
        environmentId: child.id,
        variableId: childOnly.variable.id,
        allowedHosts: ["api.example.com"],
      });
      await prisma.secretStore.delete({ where: { key: childOnly.secretKey } });
      expect(
        await repository.getEnvironmentVariables(f.project.id, child.id, f.environment.id)
      ).not.toContainEqual({ key: "CHILD_TOKEN", value: "ordinary-parent" });
    }
  );

  postgresTest(
    "scopes refusals of a valid run's selections so the relay keeps its other grants",
    async ({ prisma }) => {
      const f = await seed(prisma);
      const secret = await f.variable("API_TOKEN", "secret-one");
      await enrollProxyOnlyValue(prisma, {
        environmentId: f.environment.id,
        variableId: secret.variable.id,
        allowedHosts: ["api.example.com"],
      });
      const token = await f.sign();
      const own = placeholderForVariable(
        placeholderKeys,
        { runId: f.run.friendlyId, attempt: 1 },
        secret.variable.id
      );
      const previousRun = placeholderForVariable(
        placeholderKeys,
        { runId: RunId.generate().friendlyId, attempt: 1 },
        secret.variable.id
      );
      const resolveOver = async (
        resolve: Array<{ handle: string; hostname: string }>,
        runToken = token
      ) => {
        const response = await resolveSecretProxyRequest(
          f.service,
          new Request("https://platform.example.com/engine/v1/secret-proxy/resolve", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-trigger-secret-proxy-token": serviceToken,
              authorization: `Bearer ${runToken}`,
            },
            body: JSON.stringify({
              bindingId: "allocation-1",
              resolve: resolve.map((item) => ({ ...item, port: 443 })),
            }),
          })
        );
        return { status: response.status, body: await response.json() };
      };
      const stale = { handle: previousRun, hostname: "api.example.com" };
      const wrongHost = { handle: own, hostname: "other.example.com" };
      const valid = { handle: own, hostname: "api.example.com" };

      for (const refused of [stale, wrongHost]) {
        expect(await resolveOver([valid, refused])).toEqual({
          status: 403,
          body: { error: "Resolution denied", scope: "selection", selections: [refused] },
        });
      }
      expect(await resolveOver([valid])).toMatchObject({ status: 200 });
      // A refused selection must not be reported as selection-scoped when the run itself is invalid.
      expect(await resolveOver([stale], await f.sign({ attempt: 2 }))).toEqual({
        status: 403,
        body: { error: "Resolution denied", scope: "run" },
      });
    }
  );

  postgresTest("treats unrecognized proxy config as allowing no hosts", async ({ prisma }) => {
    const f = await seed(prisma);
    const secret = await f.variable("API_TOKEN", "credential");
    await enrollProxyOnlyValue(prisma, {
      environmentId: f.environment.id,
      variableId: secret.variable.id,
      allowedHosts: ["api.example.com"],
    });
    await prisma.environmentVariableValue.update({
      where: { id: secret.record.id },
      data: { proxyConfig: { allowedHosts: ["api.example.com"], paths: ["/v1"] } },
    });
    const handle = placeholderForVariable(
      placeholderKeys,
      { runId: f.run.friendlyId, attempt: 1 },
      secret.variable.id
    );
    await expect(
      f.service.resolve(serviceToken, await f.sign(), requestFor(handle))
    ).rejects.toThrow("not authorized");
  });

  postgresTest(
    "caps authorization by verified JWT expiry and conservatively bounds legacy credentials",
    async ({ prisma }) => {
      const f = await seed(prisma);
      const value = await f.variable("LEGACY_TOKEN", "unused");
      await prisma.secretStore.update({
        where: { key: value.secretKey },
        data: { version: "1", value: { secret: "legacy-plaintext" } },
      });
      await enrollProxyOnlyValue(prisma, {
        environmentId: f.environment.id,
        variableId: value.variable.id,
        allowedHosts: ["api.example.com"],
      });
      const token = await f.sign({}, 10);
      const handle = placeholderForVariable(
        placeholderKeys,
        { runId: f.run.friendlyId, attempt: 1 },
        value.variable.id
      );
      const result = await f.service.resolve(serviceToken, token, requestFor(handle));
      expect(result.expiresAtMs).toBeLessThanOrEqual(Date.now() + 10_000);
      expect(result.credentials[0]).toMatchObject({
        value: "legacy-plaintext",
      });
      expect(result.expiresAtMs).toBeLessThanOrEqual(Date.now() + 30_000);
      expect(result.expiresAtMs).toBeGreaterThan(Date.now());
      await expect(
        f.service.resolve(serviceToken, token, {
          bindingId: "allocation-1",
          resolve: [{ handle, hostname: "127.0.0.1", port: 443 }],
        })
      ).rejects.toThrow();
      await expect(
        f.service.resolve(serviceToken, token, {
          bindingId: "allocation-1",
          resolve: [{ handle, hostname: "api.example.com", port: 80 }],
        })
      ).rejects.toThrow();
    }
  );
});
