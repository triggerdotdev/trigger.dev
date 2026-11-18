import { postgresTest } from "@internal/testcontainers";
import { boundedIn, $transaction as realTransaction } from "@trigger.dev/database";
import type { PrismaClient } from "@trigger.dev/database";
import rbacPlugin from "@trigger.dev/rbac";
import { afterEach, describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const db = vi.hoisted(() => ({ client: null as unknown as PrismaClient }));

vi.mock("~/env.server", async () => {
  const { withLegacyEncryptionKeyring } = await import("./helpers/encryptionEnv");
  const { auditRecordingEnv } = await import("./helpers/auditLogPlugin");
  return auditRecordingEnv({
    env: withLegacyEncryptionKeyring({
      ENCRYPTION_KEY: "12345678901234567890123456789012",
      SESSION_SECRET: "test-session-secret",
      ADMIN_API_ENABLED: true,
      API_KEY_ALLOW_PRIVATE_IP_RANGES: false,
      // The per-org recording flag's settings, at their schema defaults: a hand-built env has none.
      AUDIT_LOGS_RECORDING_FLAG_CACHE_TTL_MS: 30_000,
      AUDIT_LOGS_RECORDING_FLAG_CACHE_MAX_ENTRIES: 50_000,
      AUDIT_LOGS_RECORDING_FLAG_LOOKUP_TIMEOUT_MS: 5_000,
    }),
  });
});

vi.mock("~/db.server", () => ({
  get prisma() {
    return db.client;
  },
  get $replica() {
    return db.client;
  },
  boundedIn,
  $transaction: (
    client: PrismaClient,
    nameOrFn: unknown,
    fnOrOptions?: unknown,
    options?: unknown
  ) => {
    const fn = (typeof nameOrFn === "function" ? nameOrFn : fnOrOptions) as Parameters<
      typeof realTransaction
    >[1];
    const opts = (typeof nameOrFn === "function" ? fnOrOptions : options) as Parameters<
      typeof realTransaction
    >[3];
    return realTransaction(client, fn, () => {}, opts);
  },
}));

import {
  createEnvironmentApiKey,
  disableRootApiKeyVisibility,
  regenerateApiKey,
  revokeEnvironmentApiKey,
  updateEnvironmentApiKeyAccess,
  updateEnvironmentApiKeyIpRanges,
} from "~/models/api-key.server";
import { action as extendGraceAction } from "~/routes/admin.api.v1.revoked-api-keys.$revokedApiKeyId";
import { $transaction } from "~/db.server";
import { deleteOrgMember, prepareMemberRemovalKeys } from "~/models/deleteOrgMember.server";
import { noteSessionAuthentication } from "~/services/auditLogs/auditContext.server";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import {
  recordMemberRemovalCredentials,
  SYSTEM_ACTOR,
} from "~/services/credentialFingerprints.server";
import { runWithHttpContext } from "~/services/httpAsyncStorage.server";
import {
  createPersonalAccessToken,
  revokePersonalAccessToken,
} from "~/services/personalAccessToken.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";
import {
  enableAuditRecording,
  inAuditedRequest,
  installAuditLogPlugin,
  uninstallAuditLogPlugin,
} from "./helpers/auditLogPlugin";

async function setup(prisma: PrismaClient) {
  db.client = prisma;
  const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  const plugin = installAuditLogPlugin();
  const disableRecording = await enableAuditRecording();
  cleanups.push(disableRecording);
  return { organization, project, user, environment, recorded: plugin.recorded };
}

const cleanups: Array<() => void> = [];

async function recordedInputs(recorded: ReturnType<typeof installAuditLogPlugin>["recorded"]) {
  await auditLogs.flush();
  return recorded.map(({ input }) => input);
}

/** Where an event about a key in `environment` happened. */
function locatedIn(environment: {
  id: string;
  organizationId: string;
  projectId: string;
  type: string;
}) {
  return {
    organizationId: environment.organizationId,
    projectId: environment.projectId,
    environmentId: environment.id,
    environmentType: environment.type,
  };
}

/** A user-issued key row, as the dashboard creates them. */
function createApiKeyRow(
  prisma: PrismaClient,
  environmentId: string,
  userId: string,
  lastFour: string
) {
  return prisma.apiKey.create({
    data: {
      name: `Key ${lastFour}`,
      keyHash: uniqueId("hash"),
      lastFour,
      runtimeEnvironmentId: environmentId,
      createdByUserId: userId,
      presetId: "ENVIRONMENT_OPERATOR",
      scopes: ["read:tasks"],
    },
  });
}

describe("credential change audit events", () => {
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    uninstallAuditLogPlugin();
  });

  // Catches: a rotation recorded without its keys' last 4 or grace period, or with a key value.
  postgresTest(
    "rotating the root key records the old and new last 4 and the grace period",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { organization, project, user, environment, recorded } = await setup(prisma);
        const previousApiKey = environment.apiKey;

        const updated = await regenerateApiKey(
          { environmentId: environment.id, userId: user.id },
          { prismaClient: prisma }
        );

        const revoked = await prisma.revokedApiKey.findFirstOrThrow({
          where: { runtimeEnvironmentId: environment.id },
        });
        const inputs = await recordedInputs(recorded);
        expect(inputs).toEqual([
          {
            category: "credentials",
            action: "api_key.rotated",
            organizationId: organization.id,
            projectId: project.id,
            environmentId: environment.id,
            environmentType: "PRODUCTION",
            target: { type: "root_api_key", id: environment.id, name: null },
            keyLast4s: [previousApiKey.slice(-4), updated.apiKey.slice(-4)],
            changes: {
              previousKeyLast4: previousApiKey.slice(-4),
              newKeyLast4: updated.apiKey.slice(-4),
              graceUntil: revoked.expiresAt.toISOString(),
            },
          },
        ]);
        const serialized = JSON.stringify(inputs);
        expect(serialized).not.toContain(previousApiKey);
        expect(serialized).not.toContain(updated.apiKey);
      })
  );

  // Catches: an immediate rotation recorded as if the old key still worked, or the earlier keys
  // whose grace it ends left out.
  postgresTest(
    "an immediate rotation records no grace period and every key it ends",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { user, environment, recorded } = await setup(prisma);
        const firstApiKey = environment.apiKey;
        const second = await regenerateApiKey(
          { environmentId: environment.id, userId: user.id },
          { prismaClient: prisma }
        );

        const third = await regenerateApiKey(
          { environmentId: environment.id, userId: user.id, revokeImmediately: true },
          { prismaClient: prisma }
        );

        const inputs = await recordedInputs(recorded);
        expect(inputs).toHaveLength(2);
        expect(inputs[1]).toEqual({
          category: "credentials",
          action: "api_key.rotated",
          ...locatedIn(environment),
          target: { type: "root_api_key", id: environment.id, name: null },
          keyLast4s: [second.apiKey.slice(-4), third.apiKey.slice(-4), firstApiKey.slice(-4)],
          changes: {
            previousKeyLast4: second.apiKey.slice(-4),
            newKeyLast4: third.apiKey.slice(-4),
            graceUntil: null,
          },
        });
      })
  );

  postgresTest("hiding the root key records the rotation it makes", async ({ prisma }) =>
    inAuditedRequest(async () => {
      const { organization, user, environment, recorded } = await setup(prisma);
      const previousApiKey = environment.apiKey;

      const updated = await disableRootApiKeyVisibility(
        { environmentId: environment.id, userId: user.id },
        { prismaClient: prisma }
      );

      const revoked = await prisma.revokedApiKey.findFirstOrThrow({
        where: { runtimeEnvironmentId: environment.id },
      });
      const inputs = await recordedInputs(recorded);
      expect(inputs).toEqual([
        {
          category: "credentials",
          action: "api_key.root_visibility_disabled",
          ...locatedIn(environment),
          organizationId: organization.id,
          target: { type: "root_api_key", id: environment.id, name: null },
          keyLast4s: [previousApiKey.slice(-4), updated.apiKey.slice(-4)],
          changes: {
            previousKeyLast4: previousApiKey.slice(-4),
            newKeyLast4: updated.apiKey.slice(-4),
            graceUntil: revoked.expiresAt.toISOString(),
          },
        },
      ]);
    })
  );

  // Catches: a new key's access recorded only as its preset, which is null for full access and
  // doesn't say what a CUSTOM or task-selecting key can do.
  postgresTest("creating a key records its name, last 4 and access", async ({ prisma }) =>
    inAuditedRequest(async () => {
      const { organization, project, user, environment, recorded } = await setup(prisma);
      const fallback = rbacPlugin.create(
        { primary: prisma, replica: prisma },
        { forceFallback: true }
      );

      const { apiKey, plaintext } = await createEnvironmentApiKey(
        {
          environmentId: environment.id,
          taskEnvironmentId: environment.id,
          userId: user.id,
          name: "Deploys",
          presetId: "FULL_ACCESS",
          allowedIpRanges: ["203.0.113.0/24", "198.51.100.0/24"],
        },
        { prismaClient: prisma, rbacController: fallback }
      );

      const inputs = await recordedInputs(recorded);
      expect(inputs).toEqual([
        {
          category: "credentials",
          action: "api_key.created",
          organizationId: organization.id,
          projectId: project.id,
          environmentId: environment.id,
          environmentType: "PRODUCTION",
          target: { type: "additional_api_key", id: apiKey.id, name: "Deploys" },
          keyLast4s: [plaintext.slice(-4)],
          changes: {
            presetId: null,
            scopes: "admin",
            expiresAt: null,
            // Sorted, like api_key.ip_ranges_updated.
            allowedIpRanges: "198.51.100.0/24, 203.0.113.0/24",
          },
        },
      ]);
      expect(JSON.stringify(inputs)).not.toContain(plaintext);
    })
  );

  postgresTest(
    "changing a key's access records the preset and scopes before and after",
    async ({ prisma }) =>
      inAuditedRequest(async () => {
        const { user, environment, recorded } = await setup(prisma);
        const apiKey = await createApiKeyRow(prisma, environment.id, user.id, "acc1");

        await updateEnvironmentApiKeyAccess(
          {
            environmentId: environment.id,
            taskEnvironmentId: environment.id,
            userId: user.id,
            apiKeyId: apiKey.id,
            presetId: "CUSTOM",
          },
          {
            prismaClient: prisma,
            rbacController: {
              prepareApiKeyPolicy: async () => ({
                ok: true,
                policy: { presetId: "CUSTOM", scopes: ["read:tasks", "trigger:tasks"] },
              }),
            },
          }
        );

        // The same access again changes nothing, so it records nothing.
        await updateEnvironmentApiKeyAccess(
          {
            environmentId: environment.id,
            taskEnvironmentId: environment.id,
            userId: user.id,
            apiKeyId: apiKey.id,
            presetId: "CUSTOM",
          },
          {
            prismaClient: prisma,
            rbacController: {
              prepareApiKeyPolicy: async () => ({
                ok: true,
                policy: { presetId: "CUSTOM", scopes: ["trigger:tasks", "read:tasks"] },
              }),
            },
          }
        );

        expect(await recordedInputs(recorded)).toEqual([
          {
            category: "credentials",
            action: "api_key.access_changed",
            ...locatedIn(environment),
            target: { type: "additional_api_key", id: apiKey.id, name: "Key acc1" },
            keyLast4s: ["acc1"],
            changes: {
              presetId: { before: "ENVIRONMENT_OPERATOR", after: "CUSTOM" },
              scopes: { before: "read:tasks", after: "read:tasks, trigger:tasks" },
            },
          },
        ]);
      })
  );

  postgresTest("revoking a key and changing its IP ranges are recorded", async ({ prisma }) =>
    inAuditedRequest(async () => {
      const { organization, user, environment, recorded } = await setup(prisma);
      const apiKey = await createApiKeyRow(prisma, environment.id, user.id, "rev1");

      const ranges = await updateEnvironmentApiKeyIpRanges(
        { environmentId: environment.id, apiKeyId: apiKey.id, allowedIpRanges: ["198.51.100.7"] },
        { prismaClient: prisma }
      );
      // The same ranges again change nothing, so they record nothing.
      await updateEnvironmentApiKeyIpRanges(
        { environmentId: environment.id, apiKeyId: apiKey.id, allowedIpRanges: ["198.51.100.7"] },
        { prismaClient: prisma }
      );
      await revokeEnvironmentApiKey(
        { environmentId: environment.id, apiKeyId: apiKey.id, userId: user.id },
        { prismaClient: prisma }
      );

      const target = { type: "additional_api_key", id: apiKey.id, name: "Key rev1" };
      expect(ranges).toHaveLength(1);
      expect(await recordedInputs(recorded)).toEqual([
        {
          category: "credentials",
          action: "api_key.ip_ranges_updated",
          ...locatedIn(environment),
          organizationId: organization.id,
          target,
          keyLast4s: ["rev1"],
          changes: { allowedIpRanges: { before: "", after: ranges[0] } },
        },
        {
          category: "credentials",
          action: "api_key.revoked",
          ...locatedIn(environment),
          target,
          keyLast4s: ["rev1"],
        },
      ]);
    })
  );

  // Catches: the read of the previous ranges, which only feeds the audit event, running while
  // recording is off.
  postgresTest(
    "changing a key's IP ranges reads the previous ranges only while recording",
    async ({ prisma }) => {
      const { user, environment } = await setup(prisma);
      const apiKey = await createApiKeyRow(prisma, environment.id, user.id, "ipr1");
      const findFirst = vi.fn(prisma.apiKey.findFirst.bind(prisma.apiKey));
      const prismaClient = {
        apiKey: {
          findFirst,
          updateManyAndReturn: prisma.apiKey.updateManyAndReturn.bind(prisma.apiKey),
        },
      } as unknown as Pick<PrismaClient, "apiKey">;
      const update = (allowedIpRanges: string[]) =>
        updateEnvironmentApiKeyIpRanges(
          { environmentId: environment.id, apiKeyId: apiKey.id, allowedIpRanges },
          { prismaClient }
        );

      await update(["198.51.100.7"]);
      expect(findFirst).toHaveBeenCalledTimes(1);

      cleanups.pop()!();
      expect(auditLogs.isRecordingEnabled()).toBe(false);
      await update(["198.51.100.8"]);
      expect(findFirst).toHaveBeenCalledTimes(1);
    }
  );

  // Catches: a change that didn't happen being recorded.
  postgresTest("a refused change records nothing", async ({ prisma }) => {
    const { user, environment, recorded } = await setup(prisma);
    const apiKey = await createApiKeyRow(prisma, environment.id, user.id, "ref1");
    await prisma.apiKey.update({ where: { id: apiKey.id }, data: { revokedAt: new Date() } });

    await expect(
      revokeEnvironmentApiKey(
        { environmentId: environment.id, apiKeyId: apiKey.id },
        { prismaClient: prisma }
      )
    ).rejects.toThrow();
    await expect(
      updateEnvironmentApiKeyIpRanges(
        { environmentId: environment.id, apiKeyId: apiKey.id, allowedIpRanges: [] },
        { prismaClient: prisma }
      )
    ).rejects.toThrow();
    await expect(
      updateEnvironmentApiKeyAccess(
        {
          environmentId: environment.id,
          taskEnvironmentId: environment.id,
          userId: user.id,
          apiKeyId: apiKey.id,
          presetId: "CUSTOM",
        },
        {
          prismaClient: prisma,
          rbacController: {
            prepareApiKeyPolicy: async () => ({
              ok: true,
              policy: { presetId: "CUSTOM", scopes: ["read:tasks"] },
            }),
          },
        }
      )
    ).rejects.toThrow();
    // A hidden root key can't be rotated and returned.
    await prisma.runtimeEnvironment.update({
      where: { id: environment.id },
      data: { rootApiKeyHiddenAt: new Date() },
    });
    await expect(
      regenerateApiKey({ environmentId: environment.id, userId: user.id }, { prismaClient: prisma })
    ).rejects.toThrow();

    expect(await recordedInputs(recorded)).toEqual([]);
  });

  // Catches: the extension recorded with the staff member or the customer as its actor, instead of
  // as support with the staff member only in onBehalfOf. Checks what the endpoint passes to
  // record(), not what the customer's log later shows.
  postgresTest(
    "support extending a grace period is recorded as Trigger.dev support",
    async ({ prisma }) => {
      const { organization, environment, recorded } = await setup(prisma);
      const admin = await prisma.user.create({
        data: {
          email: `${uniqueId("admin")}@example.com`,
          authenticationMethod: "MAGIC_LINK",
          admin: true,
        },
      });
      const pat = await createPersonalAccessToken({ name: "admin", userId: admin.id });
      await auditLogs.flush();
      recorded.length = 0;
      const revokedApiKey = await prisma.revokedApiKey.create({
        data: {
          apiKey: `tr_prod_${uniqueId("old")}abcd`,
          runtimeEnvironmentId: environment.id,
          expiresAt: new Date("2030-01-01T00:00:00.000Z"),
        },
      });

      const extendTo = (expiresAt: string) =>
        extendGraceAction({
          request: new Request(
            `https://api.example.com/admin/api/v1/revoked-api-keys/${revokedApiKey.id}`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${pat.token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ expiresAt }),
            }
          ),
          params: { revokedApiKeyId: revokedApiKey.id },
          context: {},
        } as never) as Promise<Response>;

      expect((await extendTo("2031-01-01T00:00:00.000Z")).status).toBe(200);
      // The same date again changes nothing, so it records nothing.
      expect((await extendTo("2031-01-01T00:00:00.000Z")).status).toBe(200);

      const inputs = await recordedInputs(recorded);
      expect(inputs).toEqual([
        {
          category: "credentials",
          action: "api_key.grace_extended",
          organizationId: organization.id,
          projectId: environment.projectId,
          environmentId: environment.id,
          environmentType: "PRODUCTION",
          target: { type: "root_api_key", id: environment.id, name: null },
          keyLast4s: ["abcd"],
          changes: {
            graceUntil: { before: "2030-01-01T00:00:00.000Z", after: "2031-01-01T00:00:00.000Z" },
          },
          actor: { type: "support", id: null },
          source: "staff",
          onBehalfOf: { userId: admin.id },
        },
      ]);
      expect(JSON.stringify(inputs)).not.toContain(revokedApiKey.apiKey);
    }
  );

  // Catches: a branch's rotation recorded on the branch, which has no key of its own.
  postgresTest("rotating from a branch records it on the parent environment", async ({ prisma }) =>
    inAuditedRequest(async () => {
      const { user, environment, recorded } = await setup(prisma);
      const branch = await prisma.runtimeEnvironment.create({
        data: {
          slug: uniqueId("branch"),
          type: "PREVIEW",
          projectId: environment.projectId,
          organizationId: environment.organizationId,
          parentEnvironmentId: environment.id,
          branchName: "feature",
          apiKey: uniqueId("api"),
          pkApiKey: uniqueId("pk"),
          shortcode: uniqueId("sc"),
        },
      });

      await regenerateApiKey(
        { environmentId: branch.id, userId: user.id },
        { prismaClient: prisma }
      );

      const inputs = await recordedInputs(recorded);
      expect(inputs.map((input) => [input.environmentId, input.target])).toEqual([
        [environment.id, { type: "root_api_key", id: environment.id, name: null }],
      ]);
    })
  );

  // Catches: a dashboard change losing its actor and source, which the plugin drops as
  // missing_actor / missing_source.
  postgresTest(
    "a dashboard request records the signed-in user as the actor",
    async ({ prisma }) => {
      const { user, environment, recorded } = await setup(prisma);
      const request = new Request("https://app.example.com/resources/regenerate-api-key", {
        headers: { "x-forwarded-for": "203.0.113.9", "user-agent": "browser" },
      });

      await runWithHttpContext(
        {
          requestId: "req_dashboard",
          path: "/resources/regenerate-api-key",
          host: "app.example.com",
          method: "POST",
          abortController: new AbortController(),
        },
        async () => {
          noteSessionAuthentication(request, { userId: user.id });
          await regenerateApiKey(
            { environmentId: environment.id, userId: user.id },
            { prismaClient: prisma }
          );
        }
      );

      await auditLogs.flush();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.context).toMatchObject({
        actor: { type: "user", id: user.id },
        source: "dashboard",
        onBehalfOf: null,
        requestId: "req_dashboard",
      });
    }
  );

  // Catches: a PAT event landing in an organization's log, a token value in the event, or a
  // directory sync revocation attributed to the user.
  postgresTest("PAT events belong to no organization", async ({ prisma }) =>
    inAuditedRequest(async () => {
      const { user, recorded } = await setup(prisma);

      const dashboardToken = await createPersonalAccessToken({ name: "laptop", userId: user.id });
      const cliToken = await createPersonalAccessToken({
        name: "cli",
        userId: user.id,
        auditLogSource: "cli",
      });
      await revokePersonalAccessToken(dashboardToken.id, user.id);
      await revokePersonalAccessToken(cliToken.id, user.id, {
        reason: "member_removed",
        revokedBy: SYSTEM_ACTOR,
      });

      const pat = (token: { id: string; name: string; token: string }) => ({
        organizationId: null,
        target: { type: "pat", id: token.id, name: token.name },
        keyLast4s: [token.token.slice(-4)],
      });
      const inputs = await recordedInputs(recorded);
      expect(inputs).toEqual([
        {
          category: "credentials",
          action: "pat.created",
          ...pat(dashboardToken),
          actor: { type: "user", id: user.id },
          changes: { expiresAt: null },
        },
        {
          category: "credentials",
          action: "pat.created",
          ...pat(cliToken),
          actor: { type: "user", id: user.id },
          source: "cli",
          changes: { expiresAt: null },
        },
        {
          category: "credentials",
          action: "pat.revoked",
          ...pat(dashboardToken),
          actor: { type: "user", id: user.id },
          changes: { reason: "revoked" },
        },
        {
          category: "credentials",
          action: "pat.revoked",
          ...pat(cliToken),
          actor: { type: "system", id: null },
          source: "system",
          changes: { reason: "member_removed" },
        },
      ]);
      const serialized = JSON.stringify(inputs);
      expect(serialized).not.toContain(dashboardToken.token);
      expect(serialized).not.toContain(cliToken.token);
    })
  );

  // Catches: the keys a member removal rotates and revokes leaving no event, or a directory sync
  // removal attributed to whoever made the request.
  postgresTest(
    "removing a member records their development keys' rotation and revocation",
    async ({ prisma }) => {
      const { organization, project, user, recorded } = await setup(prisma);
      const membership = organization.members[0]!;
      const development = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "DEVELOPMENT",
        orgMemberId: membership.id,
      });
      const apiKey = await createApiKeyRow(prisma, development.id, user.id, "dev1");
      const member = { id: membership.id, organizationId: organization.id };

      const newKeys = await prepareMemberRemovalKeys(prisma, member, SYSTEM_ACTOR);
      const result = await $transaction(prisma, "delete org member", (tx) =>
        deleteOrgMember(tx, member, newKeys)
      );
      expect(result).toBeDefined();
      recordMemberRemovalCredentials(result!.credentials, SYSTEM_ACTOR);

      const rotated = await prisma.runtimeEnvironment.findFirst({
        where: { id: development.id },
      });
      if (!rotated) {
        throw new Error("Development environment not found");
      }
      const system = { actor: { type: "system", id: null }, source: "system" };
      expect(await recordedInputs(recorded)).toEqual([
        {
          category: "credentials",
          action: "api_key.rotated",
          ...locatedIn(development),
          target: { type: "root_api_key", id: development.id, name: null },
          keyLast4s: [development.apiKey.slice(-4), rotated.apiKey.slice(-4)],
          changes: {
            previousKeyLast4: development.apiKey.slice(-4),
            newKeyLast4: rotated.apiKey.slice(-4),
            graceUntil: null,
            reason: "member_removed",
          },
          ...system,
        },
        {
          category: "credentials",
          action: "api_key.revoked",
          ...locatedIn(development),
          target: { type: "additional_api_key", id: apiKey.id, name: "Key dev1" },
          keyLast4s: ["dev1"],
          changes: { reason: "member_removed" },
          ...system,
        },
      ]);
    }
  );
});
