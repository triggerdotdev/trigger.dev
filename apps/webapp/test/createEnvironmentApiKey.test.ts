import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import rbacPlugin, { type RoleBaseAccessController } from "@trigger.dev/rbac";
import { expect, vi } from "vitest";
import { MAX_API_KEY_TASK_IDENTIFIERS } from "~/consts";
import { createEnvironmentApiKey, revokeEnvironmentApiKey } from "~/models/api-key.server";
import type { ApiKeyTelemetry } from "~/services/apiKeyTelemetry.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
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
  const [environment] = await Promise.all([
    createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
      slug: uniqueId("prod"),
    }),
    prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: { [FEATURE_FLAG.additionalApiKeysEnabled]: true } },
    }),
    prisma.featureFlag.upsert({
      where: { key: FEATURE_FLAG.additionalApiKeyIssuanceEnabled },
      create: { key: FEATURE_FLAG.additionalApiKeyIssuanceEnabled, value: true },
      update: { value: true },
    }),
  ]);
  return { organization, project, user, environment };
}

containerTest(
  "rejects creation when the system-wide issuance gate is disabled",
  async ({ prisma }) => {
    const { user, environment } = await setup(prisma);
    await prisma.featureFlag.update({
      where: { key: FEATURE_FLAG.additionalApiKeyIssuanceEnabled },
      data: { value: false },
    });
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
          name: "Disabled",
          presetId: "FULL_ACCESS",
        },
        { prismaClient: prisma, rbacController: controller }
      )
    ).rejects.toThrow("Creating additional API keys is not enabled");

    expect(controller.prepareApiKeyPolicy).not.toHaveBeenCalled();
    await expect(
      prisma.apiKey.count({ where: { runtimeEnvironmentId: environment.id } })
    ).resolves.toBe(0);
  }
);

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
    error: "This API key access preset is not available on your plan",
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
  ).rejects.toThrow("not available on your plan");

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
