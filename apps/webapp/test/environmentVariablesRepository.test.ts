import { describe, expect, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  $transaction: async (
    prismaClient: {
      $transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown>;
    },
    nameOrFn: string | ((tx: unknown) => Promise<unknown>),
    fnOrOptions?: ((tx: unknown) => Promise<unknown>) | unknown
  ) => {
    const fn =
      typeof nameOrFn === "string" ? (fnOrOptions as (tx: unknown) => Promise<unknown>) : nameOrFn;

    return prismaClient.$transaction(fn);
  },
}));

import { postgresTest } from "@internal/testcontainers";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  createEnvironmentVariable,
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

describe("EnvironmentVariablesRepository.getVariableValuesForKeys", () => {
  postgresTest("returns an empty map for an empty items array", async ({ prisma }) => {
    const { project } = await createTestOrgProjectWithMember(prisma);
    const repository = new EnvironmentVariablesRepository(prisma, prisma);

    const result = await repository.getVariableValuesForKeys(project.id, []);

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  postgresTest("omits missing keys from the result without throwing", async ({ prisma }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    const repository = new EnvironmentVariablesRepository(prisma, prisma);

    const result = await repository.getVariableValuesForKeys(project.id, [
      { environmentId: environment.id, key: "DOES_NOT_EXIST" },
    ]);

    expect(result.size).toBe(0);
    expect(result.has(`${environment.id}:DOES_NOT_EXIST`)).toBe(false);
  });

  postgresTest(
    "returns requested values with correct map keys and decrypted values",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const environment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });

      const repository = new EnvironmentVariablesRepository(prisma, prisma);

      await createEnvironmentVariable(repository, project.id, {
        environmentId: environment.id,
        key: "VAR_A",
        value: "value-a",
        userId: user.id,
      });
      await createEnvironmentVariable(repository, project.id, {
        environmentId: environment.id,
        key: "VAR_B",
        value: "value-b",
        userId: user.id,
      });
      await createEnvironmentVariable(repository, project.id, {
        environmentId: environment.id,
        key: "VAR_C",
        value: "value-c",
        userId: user.id,
      });

      const result = await repository.getVariableValuesForKeys(project.id, [
        { environmentId: environment.id, key: "VAR_A" },
        { environmentId: environment.id, key: "VAR_C" },
      ]);

      expect(result).toBeInstanceOf(Map);
      expect(result.size).toBe(2);
      expect(result.get(`${environment.id}:VAR_A`)).toBe("value-a");
      expect(result.get(`${environment.id}:VAR_C`)).toBe("value-c");
      expect(result.has(`${environment.id}:VAR_B`)).toBe(false);
    }
  );

  postgresTest("deduplicates duplicate environmentId and key requests", async ({ prisma }) => {
    const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    const repository = new EnvironmentVariablesRepository(prisma, prisma);

    await createEnvironmentVariable(repository, project.id, {
      environmentId: environment.id,
      key: "DEDUP_KEY",
      value: "dedup-value",
      userId: user.id,
    });

    const request = { environmentId: environment.id, key: "DEDUP_KEY" };
    const result = await repository.getVariableValuesForKeys(project.id, [
      request,
      request,
      request,
    ]);

    expect(result.size).toBe(1);
    expect(result.get(`${environment.id}:DEDUP_KEY`)).toBe("dedup-value");
  });

  postgresTest("isolates values by project", async ({ prisma }) => {
    const { user, organization, project: projectA } = await createTestOrgProjectWithMember(prisma);

    const projectB = await prisma.project.create({
      data: {
        name: "Project B",
        slug: `proj-b-${Date.now()}`,
        organizationId: organization.id,
        externalRef: `ext-b-${Date.now()}`,
      },
    });

    const envA = await createRuntimeEnvironment(prisma, {
      projectId: projectA.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const envB = await createRuntimeEnvironment(prisma, {
      projectId: projectB.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    const repository = new EnvironmentVariablesRepository(prisma, prisma);

    await createEnvironmentVariable(repository, projectA.id, {
      environmentId: envA.id,
      key: "SHARED_KEY",
      value: "project-a-value",
      userId: user.id,
    });
    await createEnvironmentVariable(repository, projectB.id, {
      environmentId: envB.id,
      key: "SHARED_KEY",
      value: "project-b-value",
      userId: user.id,
    });

    const resultForProjectA = await repository.getVariableValuesForKeys(projectA.id, [
      { environmentId: envA.id, key: "SHARED_KEY" },
    ]);

    expect(resultForProjectA.size).toBe(1);
    expect(resultForProjectA.get(`${envA.id}:SHARED_KEY`)).toBe("project-a-value");
    expect(resultForProjectA.get(`${envB.id}:SHARED_KEY`)).toBeUndefined();

    const crossProjectRequest = await repository.getVariableValuesForKeys(projectA.id, [
      { environmentId: envB.id, key: "SHARED_KEY" },
    ]);

    expect(crossProjectRequest.size).toBe(0);
  });

  postgresTest(
    "create() rejects a mix of in-project and foreign environmentIds without writing foreign values",
    async ({ prisma }) => {
      const {
        user,
        organization,
        project: projectA,
      } = await createTestOrgProjectWithMember(prisma);

      const projectB = await prisma.project.create({
        data: {
          name: "Project B",
          slug: `proj-b-${Date.now()}`,
          organizationId: organization.id,
          externalRef: `ext-b-${Date.now()}`,
        },
      });

      const envA = await createRuntimeEnvironment(prisma, {
        projectId: projectA.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });
      const envB = await createRuntimeEnvironment(prisma, {
        projectId: projectB.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });

      const repository = new EnvironmentVariablesRepository(prisma, prisma);

      // Caller scoped to projectA supplies a mixed array: an in-project env
      // (envA) plus a foreign one (envB). The whole request must be refused.
      const result = await repository.create(projectA.id, {
        override: true,
        environmentIds: [envA.id, envB.id],
        variables: [{ key: "CROSS_TENANT", value: "x" }],
        isSecret: false,
        lastUpdatedBy: { type: "user", userId: user.id },
      });

      expect(result.success).toBe(false);

      // No value row may have been written against the foreign environment.
      const foreignValues = await prisma.environmentVariableValue.findMany({
        where: { environmentId: envB.id },
      });
      expect(foreignValues).toHaveLength(0);
    }
  );

  postgresTest(
    "create() still succeeds for an all-in-project environmentIds array",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);

      const environment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });

      const repository = new EnvironmentVariablesRepository(prisma, prisma);

      const result = await repository.create(project.id, {
        override: true,
        environmentIds: [environment.id],
        variables: [{ key: "OK_KEY", value: "v" }],
        isSecret: false,
        lastUpdatedBy: { type: "user", userId: user.id },
      });

      expect(result.success).toBe(true);
    }
  );
});

describe("EnvironmentVariablesRepository.editValue", () => {
  postgresTest(
    "permanently marks an existing value as secret while updating its value",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const environment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });
      const repository = new EnvironmentVariablesRepository(prisma, prisma);

      await createEnvironmentVariable(repository, project.id, {
        environmentId: environment.id,
        key: "BECOMES_SECRET",
        value: "plain-value",
        userId: user.id,
      });

      const variable = await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: project.id, key: "BECOMES_SECRET" },
        include: { values: { where: { environmentId: environment.id } } },
      });
      const originalVersion = variable.values[0]!.version;

      const result = await repository.editValue(project.id, {
        id: variable.id,
        environmentId: environment.id,
        value: "new-secret-value",
        isSecret: true,
        lastUpdatedBy: { type: "user", userId: user.id },
      });

      expect(result).toEqual({ success: true });

      const updatedValue = await prisma.environmentVariableValue.findUniqueOrThrow({
        where: {
          variableId_environmentId: {
            variableId: variable.id,
            environmentId: environment.id,
          },
        },
      });
      expect(updatedValue.isSecret).toBe(true);
      expect(updatedValue.version).toBe(originalVersion + 1);

      const unredacted = await repository.getEnvironment(project.id, environment.id);
      expect(unredacted).toEqual([
        expect.objectContaining({ key: "BECOMES_SECRET", value: "new-secret-value" }),
      ]);

      const redacted = await repository.getEnvironmentWithRedactedSecrets(
        project.id,
        environment.id
      );
      expect(redacted).toEqual([
        expect.objectContaining({ key: "BECOMES_SECRET", value: "<redacted>", isSecret: true }),
      ]);
    }
  );

  postgresTest("does not change an existing secret value back to plaintext", async ({ prisma }) => {
    const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const repository = new EnvironmentVariablesRepository(prisma, prisma);

    await createEnvironmentVariable(repository, project.id, {
      environmentId: environment.id,
      key: "STAYS_SECRET",
      value: "original-secret",
      isSecret: true,
      userId: user.id,
    });

    const variable = await prisma.environmentVariable.findFirstOrThrow({
      where: { projectId: project.id, key: "STAYS_SECRET" },
    });

    const result = await repository.editValue(project.id, {
      id: variable.id,
      environmentId: environment.id,
      value: "updated-secret",
      isSecret: false,
      lastUpdatedBy: { type: "user", userId: user.id },
    });

    expect(result).toEqual({ success: true });

    const updatedValue = await prisma.environmentVariableValue.findUniqueOrThrow({
      where: {
        variableId_environmentId: {
          variableId: variable.id,
          environmentId: environment.id,
        },
      },
    });
    expect(updatedValue.isSecret).toBe(true);

    const unredacted = await repository.getEnvironment(project.id, environment.id);
    expect(unredacted).toEqual([
      expect.objectContaining({ key: "STAYS_SECRET", value: "updated-secret" }),
    ]);
  });
});
