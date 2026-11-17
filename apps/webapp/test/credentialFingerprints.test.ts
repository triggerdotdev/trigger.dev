import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { AuditLogCredentialFingerprintInput } from "@trigger.dev/plugins";
import rbacPlugin from "@trigger.dev/rbac";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEnvironmentApiKey,
  disableRootApiKeyVisibility,
  regenerateApiKey,
  revokeEnvironmentApiKey,
} from "~/models/api-key.server";
import { deleteOrgMember, prepareMemberRemovalKeys } from "~/models/deleteOrgMember.server";
import { createEnvironment } from "~/models/organization.server";
import { removeTeamMember } from "~/models/removeTeamMember.server";
import { noteOrganizationAccessTokenAuthentication } from "~/services/auditLogs/auditContext.server";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import {
  recordMemberRemovalCredentials,
  updateCredentialGrace,
  userActor,
} from "~/services/credentialFingerprints.server";
import { runWithHttpContext } from "~/services/httpAsyncStorage.server";
import { UpsertBranchService } from "~/services/upsertBranch.server";
import { generateAdditionalApiKey, hashApiKey } from "~/utils/apiKeys";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  createTestUser,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";
import { installAuditLogPlugin, uninstallAuditLogPlugin } from "./helpers/auditLogPlugin";

vi.setConfig({ testTimeout: 60_000 });

afterEach(uninstallAuditLogPlugin);

const savedHashes = (saved: AuditLogCredentialFingerprintInput[]) => saved.map((s) => s.hash);

describe("root API key fingerprints", () => {
  containerTest(
    "rotation saves the new key and marks the old one rotated with its grace period",
    async ({ prisma }) => {
      const { saved, revoked, calls } = installAuditLogPlugin();
      const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
      const environment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });

      const result = await regenerateApiKey(
        { environmentId: environment.id, userId: user.id },
        { prismaClient: prisma }
      );
      await auditLogs.flush();

      const oldHash = hashApiKey(environment.apiKey);
      expect(saved).toEqual([
        expect.objectContaining({
          hash: hashApiKey(result.apiKey),
          kind: "root_api_key",
          organizationId: organization.id,
          projectId: project.id,
          environmentId: environment.id,
          last4: result.apiKey.slice(-4),
          createdBy: { type: "user", id: user.id },
        }),
        // The old key may predate fingerprints, so it is saved before it is marked.
        expect.objectContaining({
          hash: oldHash,
          environmentId: environment.id,
          createdBy: null,
          createdAt: null,
        }),
      ]);
      expect(calls.filter((call) => call.hash === oldHash)).toEqual([
        { call: "save", hash: oldHash },
        { call: "markRevoked", hash: oldHash },
      ]);
      const grace = await prisma.revokedApiKey.findFirstOrThrow({
        where: { runtimeEnvironmentId: environment.id },
      });
      expect(revoked).toEqual([
        expect.objectContaining({
          hash: hashApiKey(environment.apiKey),
          reason: "rotated",
          revokedBy: { type: "user", id: user.id },
          graceUntil: grace.expiresAt,
          replacedByHash: hashApiKey(result.apiKey),
        }),
      ]);
    }
  );

  containerTest(
    "an immediate rotation has no grace period and ends the grace of earlier keys",
    async ({ prisma }) => {
      const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
      const environment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });
      const earlier = await regenerateApiKey(
        { environmentId: environment.id, userId: user.id },
        { prismaClient: prisma }
      );
      const { revoked, calls } = installAuditLogPlugin();

      await regenerateApiKey(
        { environmentId: environment.id, userId: user.id, revokeImmediately: true },
        { prismaClient: prisma }
      );
      await auditLogs.flush();

      // The original key, still in its grace period, may predate fingerprints too: saved, then
      // marked.
      const graceEndedHash = hashApiKey(environment.apiKey);
      expect(calls.filter((call) => call.hash === graceEndedHash)).toEqual([
        { call: "save", hash: graceEndedHash },
        { call: "markRevoked", hash: graceEndedHash },
      ]);
      // The marks run in parallel, so their order is not fixed.
      expect(revoked).toHaveLength(2);
      expect(revoked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            hash: hashApiKey(earlier.apiKey),
            reason: "rotated_immediately",
            graceUntil: null,
          }),
          expect.objectContaining({
            hash: hashApiKey(environment.apiKey),
            graceUntil: expect.any(Date),
          }),
        ])
      );
    }
  );

  // Catches: an immediate rotation leaving a key older than fingerprints with no row, so the
  // mark (an update) records nothing and the key's end is lost.
  containerTest(
    "an immediate rotation saves the old key's fingerprint, then marks it revoked",
    async ({ prisma }) => {
      const { saved, calls } = installAuditLogPlugin();
      const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
      const environment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });

      const result = await regenerateApiKey(
        { environmentId: environment.id, userId: user.id, revokeImmediately: true },
        { prismaClient: prisma }
      );
      await auditLogs.flush();

      const oldHash = hashApiKey(environment.apiKey);
      expect(saved).toEqual(
        expect.arrayContaining([
          {
            hash: oldHash,
            kind: "root_api_key",
            organizationId: organization.id,
            projectId: project.id,
            environmentId: environment.id,
            credentialId: null,
            name: null,
            last4: environment.apiKey.slice(-4),
            createdBy: null,
            createdAt: null,
            expiresAt: null,
          },
        ])
      );
      expect(calls.filter((call) => call.hash === oldHash)).toEqual([
        { call: "save", hash: oldHash },
        { call: "markRevoked", hash: oldHash },
      ]);
      expect(saved.find((input) => input.hash === hashApiKey(result.apiKey))?.createdAt).toEqual(
        expect.any(Date)
      );
    }
  );

  // Catches: a key going live without a fingerprint, so events using it can't be attributed.
  containerTest("a failed fingerprint write fails the rotation", async ({ prisma }) => {
    installAuditLogPlugin({ failSaves: true });
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    await expect(
      regenerateApiKey({ environmentId: environment.id, userId: user.id }, { prismaClient: prisma })
    ).rejects.toThrow("Something went wrong. Please try again.");

    await expect(
      prisma.runtimeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })
    ).resolves.toMatchObject({ apiKey: environment.apiKey });
    await expect(
      prisma.revokedApiKey.count({ where: { runtimeEnvironmentId: environment.id } })
    ).resolves.toBe(0);
  });

  containerTest("hiding the root key marks the old key hidden", async ({ prisma }) => {
    const { saved, revoked, calls } = installAuditLogPlugin();
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    const result = await disableRootApiKeyVisibility(
      { environmentId: environment.id, userId: user.id },
      { prismaClient: prisma }
    );
    await auditLogs.flush();

    const oldHash = hashApiKey(environment.apiKey);
    expect(savedHashes(saved)).toEqual([hashApiKey(result.apiKey), oldHash]);
    expect(calls.filter((call) => call.hash === oldHash)).toEqual([
      { call: "save", hash: oldHash },
      { call: "markRevoked", hash: oldHash },
    ]);
    expect(revoked).toEqual([
      expect.objectContaining({
        hash: oldHash,
        reason: "hidden",
        graceUntil: expect.any(Date),
        replacedByHash: hashApiKey(result.apiKey),
      }),
    ]);
  });

  // Catches: the fingerprint naming another environment than the one created with the key.
  containerTest(
    "a new environment's root key is saved with its environment",
    async ({ prisma }) => {
      const { saved } = installAuditLogPlugin();
      const { organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);

      const environment = await createEnvironment({
        organization,
        project,
        member: orgMember,
        type: "DEVELOPMENT",
        maximumConcurrencyLimit: 5,
        prismaClient: prisma,
      });

      expect(saved).toEqual([
        expect.objectContaining({
          hash: hashApiKey(environment.apiKey),
          kind: "root_api_key",
          organizationId: organization.id,
          projectId: project.id,
          environmentId: environment.id,
        }),
      ]);
    }
  );

  containerTest(
    "a new branch's key is saved once, and not again when the branch exists",
    async ({ prisma }) => {
      const { saved } = installAuditLogPlugin();
      const { organization, project, user, orgMember } =
        await createTestOrgProjectWithMember(prisma);
      await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          apiKey: uniqueId("tr_dev"),
          pkApiKey: uniqueId("pk_dev"),
          shortcode: uniqueId("sc"),
          projectId: project.id,
          organizationId: organization.id,
          type: "DEVELOPMENT",
          orgMemberId: orgMember.id,
          isBranchableEnvironment: true,
        },
      });
      const call = () =>
        new UpsertBranchService(prisma).call(
          { type: "userMembership", userId: user.id },
          { projectId: project.id, env: "development", branchName: "feature-x" }
        );

      const first = await call();
      const second = await call();

      expect(first).toMatchObject({ success: true, alreadyExisted: false });
      expect(second).toMatchObject({ success: true, alreadyExisted: true });
      if (!first.success) throw new Error(first.error);
      expect(saved).toEqual([
        expect.objectContaining({
          hash: hashApiKey(first.branch.apiKey),
          environmentId: first.branch.id,
          createdBy: { type: "user", id: user.id },
        }),
      ]);
    }
  );

  // Catches: a branch created through the API without a user (an organization access token or an
  // API key, as in CI) saved with no creator.
  containerTest(
    "a branch created with an organization access token names the token as its creator",
    async ({ prisma }) => {
      const { saved } = installAuditLogPlugin();
      const { organization, project } = await createTestOrgProjectWithMember(prisma);
      await prisma.runtimeEnvironment.create({
        data: {
          slug: "preview",
          apiKey: uniqueId("tr_preview"),
          pkApiKey: uniqueId("pk_preview"),
          shortcode: uniqueId("sc"),
          projectId: project.id,
          organizationId: organization.id,
          type: "PREVIEW",
          isBranchableEnvironment: true,
        },
      });
      const createBranch = (branchName: string) =>
        new UpsertBranchService(prisma).call(
          { type: "orgId", organizationId: organization.id },
          { projectId: project.id, env: "preview", branchName }
        );

      const withToken = await runWithHttpContext(
        {
          requestId: "req_test",
          path: "/api/v1/projects/proj/branches",
          host: "api.trigger.dev",
          method: "POST",
          abortController: new AbortController(),
        },
        async () => {
          noteOrganizationAccessTokenAuthentication(
            new Request("https://api.trigger.dev/api/v1/projects/proj/branches", {
              headers: { Authorization: "Bearer tr_oat_abcdefgh1234" },
            }),
            { tokenId: "oat_ci" }
          );
          return createBranch("ci-branch");
        }
      );
      // Outside a request nothing says who acted, so the creator stays unknown.
      const withoutRequest = await createBranch("job-branch");

      if (!withToken.success) throw new Error(withToken.error);
      if (!withoutRequest.success) throw new Error(withoutRequest.error);
      expect(saved).toEqual([
        expect.objectContaining({
          environmentId: withToken.branch.id,
          createdBy: { type: "oat", id: "oat_ci" },
        }),
        expect.objectContaining({ environmentId: withoutRequest.branch.id, createdBy: null }),
      ]);
    }
  );
});

describe("additional API key fingerprints", () => {
  const fullAccess = (prisma: Parameters<typeof rbacPlugin.create>[0]["primary"]) =>
    rbacPlugin.create({ primary: prisma, replica: prisma }, { forceFallback: true });

  containerTest("creating a key saves it, and revoking marks it revoked", async ({ prisma }) => {
    const { saved, revoked } = installAuditLogPlugin();
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    const created = await createEnvironmentApiKey(
      {
        environmentId: environment.id,
        taskEnvironmentId: environment.id,
        userId: user.id,
        name: "CI",
        presetId: "FULL_ACCESS",
      },
      { prismaClient: prisma, rbacController: fullAccess(prisma) }
    );
    await revokeEnvironmentApiKey(
      { environmentId: environment.id, apiKeyId: created.apiKey.id, userId: user.id },
      { prismaClient: prisma }
    );
    await auditLogs.flush();

    expect(saved).toEqual([
      expect.objectContaining({
        hash: created.apiKey.keyHash,
        kind: "additional_api_key",
        organizationId: organization.id,
        environmentId: environment.id,
        name: "CI",
        last4: created.apiKey.lastFour,
      }),
    ]);
    expect(revoked).toEqual([
      expect.objectContaining({
        hash: created.apiKey.keyHash,
        reason: "revoked",
        revokedBy: { type: "user", id: user.id },
      }),
    ]);
  });

  // Catches: an additional key's fingerprint not naming its ApiKey row, so keys with the same
  // name can't be told apart once one is gone.
  containerTest("a new key's fingerprint names the key's row", async ({ prisma }) => {
    const { saved } = installAuditLogPlugin();
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    const created = await createEnvironmentApiKey(
      {
        environmentId: environment.id,
        taskEnvironmentId: environment.id,
        userId: user.id,
        name: "CI",
        presetId: "FULL_ACCESS",
      },
      { prismaClient: prisma, rbacController: fullAccess(prisma) }
    );

    const row = await prisma.apiKey.findUniqueOrThrow({
      where: { keyHash: created.apiKey.keyHash },
    });
    expect(saved).toEqual([expect.objectContaining({ credentialId: row.id })]);
    expect(row.id).toBe(created.apiKey.id);
  });

  containerTest("a failed fingerprint write creates no key", async ({ prisma }) => {
    installAuditLogPlugin({ failSaves: true });
    const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    await expect(
      createEnvironmentApiKey(
        {
          environmentId: environment.id,
          taskEnvironmentId: environment.id,
          userId: user.id,
          name: "CI",
          presetId: "FULL_ACCESS",
        },
        { prismaClient: prisma, rbacController: fullAccess(prisma) }
      )
    ).rejects.toThrow("Something went wrong. Please try again.");

    await expect(
      prisma.apiKey.count({ where: { runtimeEnvironmentId: environment.id } })
    ).resolves.toBe(0);
  });
});

describe("member removal fingerprints", () => {
  async function memberWithDevelopmentKeys(prisma: PrismaClient) {
    const { organization, project, user: admin } = await createTestOrgProjectWithMember(prisma);
    const removed = await createTestUser(prisma);
    const removedMember = await prisma.orgMember.create({
      data: { organizationId: organization.id, userId: removed.id, role: "MEMBER" },
    });
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      orgMemberId: removedMember.id,
      type: "DEVELOPMENT",
    });
    const additionalKey = generateAdditionalApiKey("DEVELOPMENT");
    await prisma.apiKey.create({
      data: {
        name: "Development key",
        runtimeEnvironmentId: environment.id,
        keyHash: additionalKey.keyHash,
        lastFour: additionalKey.lastFour,
        scopes: ["admin"],
      },
    });
    return { organization, project, admin, removedMember, environment, additionalKey };
  }

  // Catches: an old development key, made before fingerprints, having no row for its mark.
  containerTest(
    "marks the member's development keys revoked and saves the replacement root key",
    async ({ prisma }) => {
      const { organization, admin, removedMember, environment, additionalKey } =
        await memberWithDevelopmentKeys(prisma);
      const { saved, revoked, calls } = installAuditLogPlugin();

      await removeTeamMember(
        { userId: admin.id, slug: organization.slug, memberId: removedMember.id },
        prisma
      );
      await auditLogs.flush();

      const rotated = await prisma.runtimeEnvironment.findUniqueOrThrow({
        where: { id: environment.id },
      });
      const oldHash = hashApiKey(environment.apiKey);
      expect(saved).toHaveLength(2);
      expect(saved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            hash: hashApiKey(rotated.apiKey),
            kind: "root_api_key",
            environmentId: environment.id,
            createdBy: { type: "user", id: admin.id },
            createdAt: expect.any(Date),
          }),
          expect.objectContaining({
            hash: oldHash,
            kind: "root_api_key",
            environmentId: environment.id,
            createdBy: null,
            createdAt: null,
          }),
        ])
      );
      expect(calls.filter((call) => call.hash === oldHash)).toEqual([
        { call: "save", hash: oldHash },
        { call: "markRevoked", hash: oldHash },
      ]);
      // The marks run in parallel, so their order is not fixed.
      expect(revoked).toHaveLength(2);
      expect(revoked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            hash: oldHash,
            reason: "member_removed",
            revokedBy: { type: "user", id: admin.id },
            replacedByHash: hashApiKey(rotated.apiKey),
          }),
          expect.objectContaining({ hash: additionalKey.keyHash, reason: "member_removed" }),
        ])
      );
    }
  );

  // Catches: a removed member's environment getting a new key that has no fingerprint.
  containerTest(
    "a failed fingerprint save fails the removal and changes nothing",
    async ({ prisma }) => {
      const { organization, admin, removedMember, environment, additionalKey } =
        await memberWithDevelopmentKeys(prisma);
      installAuditLogPlugin({ failSaves: true });

      await expect(
        removeTeamMember(
          { userId: admin.id, slug: organization.slug, memberId: removedMember.id },
          prisma
        )
      ).rejects.toThrow("Something went wrong. Please try again.");

      await expect(
        prisma.orgMember.findUnique({ where: { id: removedMember.id } })
      ).resolves.not.toBeNull();
      await expect(
        prisma.runtimeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })
      ).resolves.toMatchObject({ apiKey: environment.apiKey });
      await expect(
        prisma.apiKey.findUniqueOrThrow({ where: { keyHash: additionalKey.keyHash } })
      ).resolves.toMatchObject({ revokedAt: null });
    }
  );

  // Catches: the new development keys being saved after the removal commits, when a failed save
  // can no longer fail it.
  containerTest(
    "the new keys' fingerprints are saved before the member is deleted",
    async ({ prisma }) => {
      const { organization, admin, removedMember, environment } =
        await memberWithDevelopmentKeys(prisma);
      const memberExistedAtSave = new Map<string, boolean>();
      const openTransactionsAtSave: number[] = [];
      installAuditLogPlugin({
        onSave: async (input) => {
          const member = await prisma.orgMember.findUnique({ where: { id: removedMember.id } });
          memberExistedAtSave.set(input.hash, member !== null);
          // A save from inside the removal's transaction would find that transaction waiting on it.
          const [{ open }] = await prisma.$queryRaw<{ open: number }[]>`
            SELECT count(*)::int AS open FROM pg_stat_activity
            WHERE datname = current_database() AND state LIKE 'idle in transaction%'`;
          openTransactionsAtSave.push(open);
        },
      });

      await removeTeamMember(
        { userId: admin.id, slug: organization.slug, memberId: removedMember.id },
        prisma
      );
      await auditLogs.flush();

      const rotated = await prisma.runtimeEnvironment.findUniqueOrThrow({
        where: { id: environment.id },
      });
      expect(memberExistedAtSave.get(hashApiKey(rotated.apiKey))).toBe(true);
      expect(openTransactionsAtSave).toEqual([0, 0]);
    }
  );

  // Catches: a removal that is then rejected leaving fingerprints for keys it never issued.
  containerTest("removing the last member saves no fingerprints", async ({ prisma }) => {
    const { organization, admin, removedMember, environment } =
      await memberWithDevelopmentKeys(prisma);
    await prisma.orgMember.delete({
      where: { organizationId_userId: { organizationId: organization.id, userId: admin.id } },
    });
    const { saved } = installAuditLogPlugin();

    await expect(
      removeTeamMember(
        { userId: removedMember.userId, slug: organization.slug, memberId: removedMember.id },
        prisma
      )
    ).rejects.toThrow("Cannot remove the last member of an organization");

    expect(saved).toEqual([]);
    await expect(
      prisma.runtimeEnvironment.findUniqueOrThrow({ where: { id: environment.id } })
    ).resolves.toMatchObject({ apiKey: environment.apiKey });
  });

  // Catches: a retried removal transaction making and setting new keys of its own, which would
  // have no fingerprint (only the prepared keys are saved before the transaction).
  containerTest("a retried removal sets the prepared keys again", async ({ prisma }) => {
    const { organization, admin, removedMember, environment } =
      await memberWithDevelopmentKeys(prisma);
    const { saved } = installAuditLogPlugin();
    const member = { id: removedMember.id, organizationId: organization.id };
    const newKeys = await prepareMemberRemovalKeys(prisma, member, userActor(admin.id));

    // The first attempt rolls back, as a serialization failure would.
    await expect(
      prisma.$transaction(async (tx) => {
        await deleteOrgMember(tx, member, newKeys);
        throw new Error("could not serialize access");
      })
    ).rejects.toThrow("could not serialize access");
    const { credentials } = await prisma.$transaction((tx) => deleteOrgMember(tx, member, newKeys));

    const rotated = await prisma.runtimeEnvironment.findUniqueOrThrow({
      where: { id: environment.id },
    });
    expect(rotated.apiKey).toBe(newKeys.get(environment.id));
    expect(credentials.rotatedRootApiKeys).toEqual([
      expect.objectContaining({ apiKey: newKeys.get(environment.id), fingerprintSaved: true }),
    ]);
    expect(saved).toHaveLength(1);
  });

  // Catches: a development environment created after the keys were prepared getting a new key
  // with no fingerprint, or the prepared keys not being the ones the removal sets.
  containerTest(
    "an environment created after the keys were prepared gets a key saved after commit",
    async ({ prisma }) => {
      const { organization, project, admin, removedMember, environment } =
        await memberWithDevelopmentKeys(prisma);
      const { saved, revoked } = installAuditLogPlugin();
      const member = { id: removedMember.id, organizationId: organization.id };
      const actor = userActor(admin.id);

      const newKeys = await prepareMemberRemovalKeys(prisma, member, actor);
      const lateEnvironment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        orgMemberId: removedMember.id,
        type: "DEVELOPMENT",
      });
      const savedBeforeRemoval = saved.length;
      const { credentials } = await prisma.$transaction((tx) =>
        deleteOrgMember(tx, member, newKeys)
      );
      recordMemberRemovalCredentials(credentials, actor);
      await auditLogs.flush();

      const [prepared, late] = await Promise.all(
        [environment, lateEnvironment].map((env) =>
          prisma.runtimeEnvironment.findUniqueOrThrow({ where: { id: env.id } })
        )
      );
      expect(savedBeforeRemoval).toBe(1);
      expect(prepared.apiKey).toBe(newKeys.get(environment.id));
      expect(newKeys.has(lateEnvironment.id)).toBe(false);
      expect(saved.filter((input) => input.hash === hashApiKey(prepared.apiKey))).toHaveLength(1);
      expect(saved).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            hash: hashApiKey(late.apiKey),
            environmentId: lateEnvironment.id,
            createdBy: actor,
            createdAt: expect.any(Date),
          }),
        ])
      );
      expect(revoked).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            hash: hashApiKey(lateEnvironment.apiKey),
            reason: "member_removed",
            replacedByHash: hashApiKey(late.apiKey),
          }),
        ])
      );
    }
  );
});

describe("grace period extensions", () => {
  // Catches: support extending a revoked key's grace period being recorded as a new revocation,
  // which would name support as the revoker and overwrite the original reason.
  it("only moves the grace period of the key's fingerprint", async () => {
    const { revoked, graceUpdates } = installAuditLogPlugin();
    const { apiKey } = generateAdditionalApiKey("PRODUCTION");
    const graceUntil = new Date("2031-01-01T00:00:00Z");

    updateCredentialGrace(apiKey, graceUntil);
    await auditLogs.flush();

    expect(graceUpdates).toEqual([{ hash: hashApiKey(apiKey), graceUntil }]);
    expect(revoked).toEqual([]);
  });
});
