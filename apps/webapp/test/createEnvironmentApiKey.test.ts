import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { RESTRICTED_API_KEYS_PLAN_MESSAGE } from "@trigger.dev/plugins";
import rbacPlugin, { type RoleBaseAccessController } from "@trigger.dev/rbac";
import { expect, test, vi } from "vitest";
import { MAX_API_KEY_TASK_IDENTIFIERS } from "~/consts";
import {
  createEnvironmentApiKey,
  isApiKeyUserError,
  RootApiKeyNotVisibleError,
  revokeEnvironmentApiKey,
  updateEnvironmentApiKeyAccess,
  updateEnvironmentApiKeyDescription,
  updateEnvironmentApiKeyIpRanges,
} from "~/models/api-key.server";
import { removeTeamMember } from "~/models/removeTeamMember.server";
import type { ApiKeyTelemetry } from "~/services/apiKeyTelemetry.server";
import { logger } from "~/services/logger.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  createTestUser,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

function policyController(
  implementation: RoleBaseAccessController["prepareApiKeyPolicy"]
): Pick<RoleBaseAccessController, "prepareApiKeyPolicy"> {
  return { prepareApiKeyPolicy: vi.fn(implementation) };
}

function telemetryRecorder(): ApiKeyTelemetry {
  return {
    recordOperation: vi.fn(),
    recordPublicTokenMint: vi.fn(),
  };
}

async function setup(prisma: PrismaClient) {
  const { organization, project, user } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });
  return { organization, project, user, environment };
}

containerTest("standalone fallback creates one explicit full-access key", async ({ prisma }) => {
  const { user, environment } = await setup(prisma);
  const fallback = rbacPlugin.create({ primary: prisma, replica: prisma }, { forceFallback: true });
  const telemetry = telemetryRecorder();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const result = await createEnvironmentApiKey(
    {
      environmentId: environment.id,
      taskEnvironmentId: environment.id,
      userId: user.id,
      name: "Full access",
      expiresAt,
      presetId: "FULL_ACCESS",
    },
    { prismaClient: prisma, rbacController: fallback, telemetryRecorder: telemetry }
  );

  expect(telemetry.recordOperation).toHaveBeenNthCalledWith(1, "prepare_policy", "success");
  expect(telemetry.recordOperation).toHaveBeenNthCalledWith(2, "create", "success");
  expect(result.plaintext).toMatch(/^tr_prod_sk_[A-Za-z0-9]{24}$/);
  expect(result.apiKey).toMatchObject({
    presetId: null,
    scopes: ["admin"],
    expiresAt,
  });
  await expect(
    prisma.apiKey.count({ where: { runtimeEnvironmentId: environment.id } })
  ).resolves.toBe(1);
});

containerTest("cannot create a development key after its member is removed", async ({ prisma }) => {
  const { organization, project, user, orgMember } = await createTestOrgProjectWithMember(prisma);
  const admin = await createTestUser(prisma);
  await prisma.orgMember.create({
    data: { userId: admin.id, organizationId: organization.id, role: "ADMIN" },
  });
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    orgMemberId: orgMember.id,
    type: "DEVELOPMENT",
  });
  const fallback = rbacPlugin.create(prisma, { forceFallback: true });
  let policyStarted!: () => void;
  let resumePolicy!: () => void;
  const started = new Promise<void>((resolve) => {
    policyStarted = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    resumePolicy = resolve;
  });
  const telemetry = telemetryRecorder();
  const creation = createEnvironmentApiKey(
    {
      environmentId: environment.id,
      taskEnvironmentId: environment.id,
      userId: user.id,
      name: "Racing removal",
      presetId: "FULL_ACCESS",
    },
    {
      prismaClient: prisma,
      telemetryRecorder: telemetry,
      rbacController: {
        async prepareApiKeyPolicy(input) {
          policyStarted();
          await resume;
          return fallback.prepareApiKeyPolicy(input);
        },
      },
    }
  );
  const rejected = expect(creation).rejects.toThrow("Environment not found");
  await started;
  try {
    await removeTeamMember(
      { userId: admin.id, slug: organization.slug, memberId: orgMember.id },
      prisma
    );
  } finally {
    resumePolicy();
  }
  await rejected;
  expect(telemetry.recordOperation).toHaveBeenCalledWith(
    "create",
    "rejected",
    "membership_removed"
  );
  expect(telemetry.recordOperation).not.toHaveBeenCalledWith("create", "error", "database_error");
  await expect(
    prisma.apiKey.findFirst({ where: { runtimeEnvironmentId: environment.id, revokedAt: null } })
  ).resolves.toBeNull();
});

containerTest("records successful API key revocation", async ({ prisma }) => {
  const { user, environment } = await setup(prisma);
  const apiKey = await prisma.apiKey.create({
    data: {
      name: "Revoke me",
      keyHash: uniqueId("hash"),
      lastFour: "last",
      runtimeEnvironmentId: environment.id,
      createdByUserId: user.id,
      scopes: ["admin"],
    },
  });
  const telemetry = telemetryRecorder();

  await revokeEnvironmentApiKey(
    { environmentId: environment.id, apiKeyId: apiKey.id },
    { prismaClient: prisma, telemetryRecorder: telemetry }
  );

  expect(telemetry.recordOperation).toHaveBeenCalledWith("revoke", "success");
  await expect(prisma.apiKey.findUnique({ where: { id: apiKey.id } })).resolves.toMatchObject({
    revokedAt: expect.any(Date),
  });
});

containerTest("persists trusted full-access and restricted cloud policies", async ({ prisma }) => {
  const { organization, user, environment } = await setup(prisma);
  const fullAccessController = policyController(async () => ({
    ok: true,
    policy: { presetId: "FULL_ACCESS", scopes: ["admin"] },
  }));
  const restrictedController = policyController(async () => ({
    ok: true,
    policy: {
      presetId: "DEPLOYMENT_READ_ONLY",
      scopes: ["read:deployments", "read:tasks"],
    },
  }));

  const fullAccess = await createEnvironmentApiKey(
    {
      environmentId: environment.id,
      taskEnvironmentId: environment.id,
      userId: user.id,
      name: "Cloud full access",
      presetId: "FULL_ACCESS",
    },
    { prismaClient: prisma, rbacController: fullAccessController }
  );
  const restricted = await createEnvironmentApiKey(
    {
      environmentId: environment.id,
      taskEnvironmentId: environment.id,
      userId: user.id,
      name: "Restricted",
      presetId: "DEPLOYMENT_READ_ONLY",
    },
    { prismaClient: prisma, rbacController: restrictedController }
  );

  expect(fullAccess.apiKey).toMatchObject({ presetId: "FULL_ACCESS", scopes: ["admin"] });
  expect(restricted.apiKey).toMatchObject({
    presetId: "DEPLOYMENT_READ_ONLY",
    scopes: ["read:deployments", "read:tasks"],
  });
  expect(fullAccessController.prepareApiKeyPolicy).toHaveBeenCalledWith({
    organizationId: organization.id,
    presetId: "FULL_ACCESS",
    taskIdentifiers: undefined,
  });
});

containerTest("policy preparation failure inserts no credential", async ({ prisma }) => {
  const { user, environment } = await setup(prisma);
  const controller = policyController(async () => ({
    ok: false,
    error: RESTRICTED_API_KEYS_PLAN_MESSAGE,
  }));
  const telemetry = telemetryRecorder();

  await expect(
    createEnvironmentApiKey(
      {
        environmentId: environment.id,
        taskEnvironmentId: environment.id,
        userId: user.id,
        name: "Unavailable",
        presetId: "RESTRICTED",
      },
      { prismaClient: prisma, rbacController: controller, telemetryRecorder: telemetry }
    )
  ).rejects.toThrow(RESTRICTED_API_KEYS_PLAN_MESSAGE);

  expect(telemetry.recordOperation).toHaveBeenCalledWith(
    "prepare_policy",
    "rejected",
    "policy_rejected"
  );
  await expect(
    prisma.apiKey.count({ where: { runtimeEnvironmentId: environment.id } })
  ).resolves.toBe(0);
});

containerTest("rejects expired credentials before policy preparation", async ({ prisma }) => {
  const { user, environment } = await setup(prisma);
  const controller = policyController(async () => ({
    ok: true,
    policy: { presetId: null, scopes: ["admin"] },
  }));

  await expect(
    createEnvironmentApiKey(
      {
        environmentId: environment.id,
        taskEnvironmentId: environment.id,
        userId: user.id,
        name: "Already expired",
        expiresAt: new Date(Date.now() - 1_000),
        presetId: "FULL_ACCESS",
      },
      { prismaClient: prisma, rbacController: controller }
    )
  ).rejects.toThrow("Expiration must be in the future");

  expect(controller.prepareApiKeyPolicy).not.toHaveBeenCalled();
  await expect(
    prisma.apiKey.count({ where: { runtimeEnvironmentId: environment.id } })
  ).resolves.toBe(0);
});

containerTest("rejects too many task identifiers before policy preparation", async ({ prisma }) => {
  const { user, environment } = await setup(prisma);
  const controller = policyController(async () => ({
    ok: true,
    policy: { presetId: "TASKS", scopes: ["trigger:tasks"] },
  }));

  await expect(
    createEnvironmentApiKey(
      {
        environmentId: environment.id,
        taskEnvironmentId: environment.id,
        userId: user.id,
        name: "Too many tasks",
        presetId: "TASKS",
        taskIdentifiers: Array.from(
          { length: MAX_API_KEY_TASK_IDENTIFIERS + 1 },
          (_, index) => `task-${index}`
        ),
      },
      { prismaClient: prisma, rbacController: controller }
    )
  ).rejects.toThrow(`at most ${MAX_API_KEY_TASK_IDENTIFIERS} tasks`);

  expect(controller.prepareApiKeyPolicy).not.toHaveBeenCalled();
});

containerTest("unknown task identifiers insert no credential", async ({ prisma }) => {
  const { user, environment } = await setup(prisma);
  const controller = policyController(async () => ({
    ok: true,
    policy: { presetId: "TASKS", scopes: ["trigger:tasks:not-real"] },
  }));

  await expect(
    createEnvironmentApiKey(
      {
        environmentId: environment.id,
        taskEnvironmentId: environment.id,
        userId: user.id,
        name: "Unknown task",
        presetId: "TASKS",
        taskIdentifiers: ["not-real"],
      },
      { prismaClient: prisma, rbacController: controller }
    )
  ).rejects.toThrow("not available in this environment");

  expect(controller.prepareApiKeyPolicy).not.toHaveBeenCalled();
  await expect(
    prisma.apiKey.count({ where: { runtimeEnvironmentId: environment.id } })
  ).resolves.toBe(0);
});

containerTest(
  "deduplicates task input and persists only the trusted policy",
  async ({ prisma }) => {
    const { organization, project, user, environment } = await setup(prisma);
    await prisma.taskIdentifier.createMany({
      data: [
        {
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          slug: "send-email",
        },
        {
          runtimeEnvironmentId: environment.id,
          projectId: project.id,
          slug: "sync-data",
        },
      ],
    });
    const trustedScopes = ["trigger:tasks:send-email", "trigger:tasks:sync-data", "read:runs"];
    const controller = policyController(async () => ({
      ok: true,
      policy: { presetId: "TRIGGER_ONLY", scopes: trustedScopes },
    }));

    const result = await createEnvironmentApiKey(
      {
        environmentId: environment.id,
        taskEnvironmentId: environment.id,
        userId: user.id,
        name: "Selected tasks",
        presetId: "TRIGGER_ONLY",
        taskIdentifiers: [" send-email ", "sync-data", "send-email"],
      },
      { prismaClient: prisma, rbacController: controller }
    );

    expect(controller.prepareApiKeyPolicy).toHaveBeenCalledWith({
      organizationId: organization.id,
      presetId: "TRIGGER_ONLY",
      taskIdentifiers: ["send-email", "sync-data"],
    });
    expect(result.apiKey).toMatchObject({ presetId: "TRIGGER_ONLY", scopes: trustedScopes });
  }
);

containerTest("updates a key's access in place and keeps its secret", async ({ prisma }) => {
  // Catches: editing access rotating the credential, leaving the old scopes in place, or leaving no record of who changed it.
  const { organization, user, environment } = await setup(prisma);
  const apiKey = await prisma.apiKey.create({
    data: {
      name: "Drifted",
      keyHash: uniqueId("hash"),
      lastFour: "drft",
      runtimeEnvironmentId: environment.id,
      createdByUserId: user.id,
      presetId: "ENVIRONMENT_OPERATOR",
      scopes: ["read:tasks"],
    },
  });
  const controller = policyController(async () => ({
    ok: true,
    policy: { presetId: "CUSTOM", scopes: ["read:tasks", "trigger:tasks", "write:deployments"] },
  }));
  const telemetry = telemetryRecorder();
  const info = vi.spyOn(logger, "info");

  await updateEnvironmentApiKeyAccess(
    {
      environmentId: environment.id,
      taskEnvironmentId: environment.id,
      userId: user.id,
      apiKeyId: apiKey.id,
      presetId: "CUSTOM",
      capabilities: { tasks: "readTrigger", deployments: "readWrite" },
    },
    { prismaClient: prisma, rbacController: controller, telemetryRecorder: telemetry }
  );

  expect(controller.prepareApiKeyPolicy).toHaveBeenCalledWith({
    organizationId: organization.id,
    presetId: "CUSTOM",
    taskIdentifiers: undefined,
    capabilities: { tasks: "readTrigger", deployments: "readWrite" },
  });
  expect(telemetry.recordOperation).toHaveBeenCalledWith("update_access", "success");
  expect(info).toHaveBeenCalledWith("API key access updated", {
    apiKeyId: apiKey.id,
    environmentId: environment.id,
    userId: user.id,
    fromPresetId: "ENVIRONMENT_OPERATOR",
    toPresetId: "CUSTOM",
    added: ["trigger:tasks", "write:deployments"],
    removed: [],
  });
  info.mockRestore();
  await expect(prisma.apiKey.findFirst({ where: { id: apiKey.id } })).resolves.toMatchObject({
    keyHash: apiKey.keyHash,
    lastFour: "drft",
    presetId: "CUSTOM",
    scopes: ["read:tasks", "trigger:tasks", "write:deployments"],
  });
});

containerTest("refuses to edit revoked or expired keys", async ({ prisma }) => {
  // Catches: a revoked or expired credential regaining access through an edit.
  const { user, environment } = await setup(prisma);
  const create = (name: string, data: { revokedAt?: Date; expiresAt?: Date }) =>
    prisma.apiKey.create({
      data: {
        name,
        keyHash: uniqueId("hash"),
        lastFour: "dead",
        runtimeEnvironmentId: environment.id,
        createdByUserId: user.id,
        presetId: "TRIGGER_ONLY",
        scopes: ["trigger:tasks"],
        ...data,
      },
    });
  const revoked = await create("Revoked", { revokedAt: new Date() });
  const expired = await create("Expired", { expiresAt: new Date(Date.now() - 60_000) });
  const controller = policyController(async () => ({
    ok: true,
    policy: { presetId: "FULL_ACCESS", scopes: ["admin"] },
  }));
  const telemetry = telemetryRecorder();
  const update = (apiKeyId: string) =>
    updateEnvironmentApiKeyAccess(
      {
        environmentId: environment.id,
        taskEnvironmentId: environment.id,
        userId: user.id,
        apiKeyId,
        presetId: "FULL_ACCESS",
      },
      { prismaClient: prisma, rbacController: controller, telemetryRecorder: telemetry }
    );

  await expect(update(revoked.id)).rejects.toThrow(
    "This key was revoked, so its access can't be changed."
  );
  await expect(update(expired.id)).rejects.toThrow(
    "This key has expired. Create a new key instead."
  );
  await expect(update("apikey_missing")).rejects.toThrow(
    "This key no longer exists. Reload the page to see your current keys."
  );
  expect(controller.prepareApiKeyPolicy).not.toHaveBeenCalled();
  expect(telemetry.recordOperation).toHaveBeenCalledWith("update_access", "rejected", "expired");
  await expect(
    prisma.apiKey.findMany({
      where: { id: { in: [revoked.id, expired.id] } },
      select: { scopes: true },
    })
  ).resolves.toEqual([{ scopes: ["trigger:tasks"] }, { scopes: ["trigger:tasks"] }]);
});

containerTest("refuses to change or revoke system-issued keys", async ({ prisma }) => {
  const { user, environment } = await setup(prisma);
  const systemKey = await prisma.apiKey.create({
    data: {
      name: "Build key",
      keyHash: uniqueId("hash"),
      lastFour: "sysk",
      runtimeEnvironmentId: environment.id,
      presetId: "DEPLOY_ONLY",
      scopes: ["read:deployments", "write:deployments"],
      issuedBy: "SYSTEM",
    },
  });
  const controller = policyController(async () => ({
    ok: true,
    policy: { presetId: "FULL_ACCESS", scopes: ["admin"] },
  }));
  const dependencies = { prismaClient: prisma, telemetryRecorder: telemetryRecorder() };
  const target = { environmentId: environment.id, apiKeyId: systemKey.id };

  await expect(
    updateEnvironmentApiKeyAccess(
      { ...target, taskEnvironmentId: environment.id, userId: user.id, presetId: "FULL_ACCESS" },
      { ...dependencies, rbacController: controller }
    )
  ).rejects.toThrow("This key no longer exists. Reload the page to see your current keys.");
  await expect(
    updateEnvironmentApiKeyIpRanges(
      { ...target, allowedIpRanges: ["203.0.113.0/24"] },
      dependencies
    )
  ).rejects.toThrow("API key not found or already revoked");
  await expect(
    updateEnvironmentApiKeyDescription({ ...target, description: "mine now" }, dependencies)
  ).rejects.toThrow("API key not found or already revoked");
  await expect(revokeEnvironmentApiKey(target, dependencies)).rejects.toThrow(
    "API key not found or already revoked"
  );

  await expect(prisma.apiKey.findFirst({ where: { id: systemKey.id } })).resolves.toMatchObject({
    presetId: "DEPLOY_ONLY",
    scopes: ["read:deployments", "write:deployments"],
    allowedIpRanges: [],
    description: null,
    revokedAt: null,
  });
});

test("only unexpected API key action errors are reported", () => {
  // Catches: database and plugin failures in the API keys action reaching the dialog but no logs, or validation messages flooding Sentry.
  class DatabaseError extends Error {}

  expect(isApiKeyUserError(new Error("Select at least one task"))).toBe(true);
  expect(isApiKeyUserError(new RootApiKeyNotVisibleError())).toBe(true);
  expect(isApiKeyUserError(new DatabaseError("connection terminated"))).toBe(false);
  expect(isApiKeyUserError(new TypeError("undefined is not a function"))).toBe(false);
  expect(isApiKeyUserError("boom")).toBe(false);
});
