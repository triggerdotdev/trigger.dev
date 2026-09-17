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
import { emptyEnvironmentVariableValuesEnabled } from "~/v3/environmentVariables/emptyValuesFlag.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  createEnvironmentVariable,
  createRuntimeEnvironment,
  createTestOrgProjectWithMember as createBaseOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

async function createTestOrgProjectWithMember(
  prisma: Parameters<typeof createBaseOrgProjectWithMember>[0]
) {
  const data = await createBaseOrgProjectWithMember(prisma);
  await prisma.organization.update({
    where: { id: data.organization.id },
    data: { featureFlags: { allowEmptyEnvironmentVariableValues: true } },
  });
  return data;
}

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

  postgresTest(
    "create() rejects an empty environmentIds array without orphaning the key",
    async ({ prisma }) => {
      const { user, project } = await createTestOrgProjectWithMember(prisma);

      const repository = new EnvironmentVariablesRepository(prisma, prisma);

      const result = await repository.create(project.id, {
        override: true,
        environmentIds: [],
        variables: [{ key: "ORPHAN_KEY", value: "v" }],
        isSecret: false,
        lastUpdatedBy: { type: "user", userId: user.id },
      });

      expect(result.success).toBe(false);

      // The variable key must not be created when there is nowhere to store it.
      const variable = await prisma.environmentVariable.findFirst({
        where: { projectId: project.id, key: "ORPHAN_KEY" },
      });
      expect(variable).toBeNull();
    }
  );
});

describe("EnvironmentVariablesRepository empty values", () => {
  postgresTest(
    "edit() stores an empty value as a distinct, retrievable value",
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
        key: "EMPTY_ME",
        value: "not-empty",
        userId: user.id,
      });

      const variable = await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: project.id, key: "EMPTY_ME" },
      });

      const result = await repository.edit(project.id, {
        id: variable.id,
        values: [{ environmentId: environment.id, value: "" }],
        lastUpdatedBy: { type: "user", userId: user.id },
      });

      expect(result.success).toBe(true);

      // The value is stored and round-trips as "", not deleted, not absent.
      const values = await repository.getVariableValuesForKeys(project.id, [
        { environmentId: environment.id, key: "EMPTY_ME" },
      ]);
      expect(values.get(`${environment.id}:EMPTY_ME`)).toBe("");

      // The value row is retained.
      const valueRows = await prisma.environmentVariableValue.findMany({
        where: { variableId: variable.id, environmentId: environment.id },
      });
      expect(valueRows).toHaveLength(1);
    }
  );

  postgresTest(
    "edit() stores an empty value for an environment that had none",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const environment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });

      const repository = new EnvironmentVariablesRepository(prisma, prisma);

      // Seed the variable in another environment so the key exists, but leave
      // `environment` without a value for it.
      const otherEnvironment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "STAGING",
      });
      await createEnvironmentVariable(repository, project.id, {
        environmentId: otherEnvironment.id,
        key: "NEW_EMPTY",
        value: "elsewhere",
        userId: user.id,
      });

      const variable = await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: project.id, key: "NEW_EMPTY" },
      });

      const result = await repository.edit(project.id, {
        id: variable.id,
        values: [{ environmentId: environment.id, value: "" }],
        lastUpdatedBy: { type: "user", userId: user.id },
      });

      expect(result.success).toBe(true);

      const values = await repository.getVariableValuesForKeys(project.id, [
        { environmentId: environment.id, key: "NEW_EMPTY" },
      ]);
      expect(values.get(`${environment.id}:NEW_EMPTY`)).toBe("");
    }
  );

  postgresTest("create() stores an empty value", async ({ prisma }) => {
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
      variables: [{ key: "CREATED_EMPTY", value: "" }],
      isSecret: false,
      lastUpdatedBy: { type: "user", userId: user.id },
    });

    expect(result.success).toBe(true);

    const values = await repository.getVariableValuesForKeys(project.id, [
      { environmentId: environment.id, key: "CREATED_EMPTY" },
    ]);
    expect(values.get(`${environment.id}:CREATED_EMPTY`)).toBe("");
  });

  postgresTest("create() stores an empty secret value", async ({ prisma }) => {
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
      variables: [{ key: "EMPTY_SECRET", value: "" }],
      isSecret: true,
      lastUpdatedBy: { type: "user", userId: user.id },
    });

    expect(result.success).toBe(true);

    const values = await repository.getVariableValuesForKeys(project.id, [
      { environmentId: environment.id, key: "EMPTY_SECRET" },
    ]);
    expect(values.get(`${environment.id}:EMPTY_SECRET`)).toBe("");
  });

  postgresTest("edit() stores a whitespace-only value verbatim", async ({ prisma }) => {
    const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    const repository = new EnvironmentVariablesRepository(prisma, prisma);

    await createEnvironmentVariable(repository, project.id, {
      environmentId: environment.id,
      key: "WHITESPACE",
      value: "seed",
      userId: user.id,
    });

    const variable = await prisma.environmentVariable.findFirstOrThrow({
      where: { projectId: project.id, key: "WHITESPACE" },
    });

    const result = await repository.edit(project.id, {
      id: variable.id,
      values: [{ environmentId: environment.id, value: "   " }],
      lastUpdatedBy: { type: "user", userId: user.id },
    });

    expect(result.success).toBe(true);

    const values = await repository.getVariableValuesForKeys(project.id, [
      { environmentId: environment.id, key: "WHITESPACE" },
    ]);
    expect(values.get(`${environment.id}:WHITESPACE`)).toBe("   ");
  });
});

describe("EnvironmentVariablesRepository safe empty edits", () => {
  postgresTest(
    "an untouched secret is retained; selecting empty overrides previously entered text",
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
        key: "SECRET_EDIT",
        value: "original",
        isSecret: true,
        userId: user.id,
      });
      const variable = await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: project.id, key: "SECRET_EDIT" },
      });
      const edit = {
        id: variable.id,
        environmentId: environment.id,
        value: "",
        lastUpdatedBy: { type: "user" as const, userId: user.id },
      };
      expect((await repository.editValue(project.id, edit)).success).toBe(false);
      const retained = await repository.getVariableValuesForKeys(project.id, [
        { environmentId: environment.id, key: "SECRET_EDIT" },
      ]);
      expect(retained.get(`${environment.id}:SECRET_EDIT`)).toBe("original");
      expect(
        (
          await repository.editValue(project.id, {
            ...edit,
            value: "typed-before-selecting-empty",
            setEmptyValue: "true",
          })
        ).success
      ).toBe(true);
      const cleared = await repository.getVariableValuesForKeys(project.id, [
        { environmentId: environment.id, key: "SECRET_EDIT" },
      ]);
      expect(cleared.get(`${environment.id}:SECRET_EDIT`)).toBe("");
      const valueRow = await prisma.environmentVariableValue.findFirstOrThrow({
        where: { variableId: variable.id, environmentId: environment.id },
      });
      expect(valueRow.isSecret).toBe(true);
      expect(
        (await repository.editValue(project.id, { ...edit, value: "replacement" })).success
      ).toBe(true);
      expect(
        (
          await repository.getVariableValuesForKeys(project.id, [
            { environmentId: environment.id, key: "SECRET_EDIT" },
          ])
        ).get(`${environment.id}:SECRET_EDIT`)
      ).toBe("replacement");
    }
  );

  postgresTest(
    "dashboard non-secret edits can store empty without a secret confirmation",
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
        key: "PLAIN_EDIT",
        value: "original",
        userId: user.id,
      });
      const variable = await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: project.id, key: "PLAIN_EDIT" },
      });
      expect(
        (
          await repository.editValue(project.id, {
            id: variable.id,
            environmentId: environment.id,
            value: "",
          })
        ).success
      ).toBe(true);
      expect(
        (
          await repository.getVariableValuesForKeys(project.id, [
            { environmentId: environment.id, key: "PLAIN_EDIT" },
          ])
        ).get(`${environment.id}:PLAIN_EDIT`)
      ).toBe("");
    }
  );
});

postgresTest("both edit paths can replace an unreadable secret", async ({ prisma }) => {
  const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
  });
  const repository = new EnvironmentVariablesRepository(prisma, prisma);
  await createEnvironmentVariable(repository, project.id, {
    environmentId: environment.id,
    key: "REPAIR_SECRET",
    value: "before",
    isSecret: true,
    userId: user.id,
  });
  const variable = await prisma.environmentVariable.findFirstOrThrow({
    where: { projectId: project.id, key: "REPAIR_SECRET" },
  });
  for (const path of ["api", "dashboard"] as const) {
    await prisma.secretStore.update({
      where: { key: `environmentvariable:${project.id}:${environment.id}:REPAIR_SECRET` },
      data: { value: { unreadable: true } },
    });
    const result =
      path === "api"
        ? await repository.edit(project.id, {
            id: variable.id,
            values: [{ environmentId: environment.id, value: "" }],
          })
        : await repository.editValue(project.id, {
            id: variable.id,
            environmentId: environment.id,
            value: "replacement",
          });
    expect(result, path).toEqual({ success: true });
    const values = await repository.getVariableValuesForKeys(project.id, [
      { environmentId: environment.id, key: "REPAIR_SECRET" },
    ]);
    expect(values.get(`${environment.id}:REPAIR_SECRET`)).toBe(path === "api" ? "" : "replacement");
  }
});

postgresTest(
  "rollout defaults off, isolates organizations, and preserves stored empties when disabled",
  async ({ prisma }) => {
    const { organization, project } = await createBaseOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const repository = new EnvironmentVariablesRepository(prisma, prisma);
    const create = (value: string) =>
      repository.create(project.id, {
        override: true,
        environmentIds: [environment.id],
        variables: [{ key: "ROLLOUT", value }],
      });
    expect((await create("")).success).toBe(false);
    expect((await create("old")).success).toBe(true);
    const variable = await prisma.environmentVariable.findUniqueOrThrow({
      where: { projectId_key: { projectId: project.id, key: "ROLLOUT" } },
    });
    expect(
      (
        await repository.edit(project.id, {
          id: variable.id,
          values: [{ environmentId: environment.id, value: "" }],
        })
      ).success
    ).toBe(false);
    expect(
      (
        await repository.editValue(project.id, {
          id: variable.id,
          environmentId: environment.id,
          value: "",
          setEmptyValue: "true",
        })
      ).success
    ).toBe(false);
    await prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: { allowEmptyEnvironmentVariableValues: true } },
    });
    expect((await create("")).success).toBe(true);
    const other = await createBaseOrgProjectWithMember(prisma);
    const otherEnv = await createRuntimeEnvironment(prisma, {
      projectId: other.project.id,
      organizationId: other.organization.id,
      type: "PRODUCTION",
    });
    expect(
      (
        await repository.create(other.project.id, {
          override: true,
          environmentIds: [otherEnv.id],
          variables: [{ key: "ROLLOUT", value: "" }],
        })
      ).success
    ).toBe(false);
    await prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: { allowEmptyEnvironmentVariableValues: false } },
    });
    expect(await repository.getEnvironmentVariables(project.id, environment.id)).toEqual([
      { key: "ROLLOUT", value: "" },
    ]);
    expect(
      (
        await repository.editValue(project.id, {
          id: variable.id,
          environmentId: environment.id,
          value: "restored",
        })
      ).success
    ).toBe(true);
    expect(
      (await repository.deleteValue(project.id, { id: variable.id, environmentId: environment.id }))
        .success
    ).toBe(true);
  }
);

postgresTest(
  "disabled rollout skips empty integration entries without dropping nonempty entries",
  async ({ prisma }) => {
    const { organization, project } = await createBaseOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const repository = new EnvironmentVariablesRepository(prisma, prisma);
    const common = {
      override: true,
      environmentIds: [environment.id],
      lastUpdatedBy: { type: "integration" as const, integration: "vercel" },
    };
    await repository.create(project.id, { ...common, variables: [{ key: "KEEP", value: "old" }] });
    expect(
      (await repository.create(project.id, { ...common, variables: [{ key: "KEEP", value: "" }] }))
        .success
    ).toBe(true);
    expect(
      (
        await repository.create(project.id, {
          ...common,
          variables: [
            { key: "KEEP", value: "" },
            { key: "NEW", value: "set" },
          ],
        })
      ).success
    ).toBe(true);
    const values = Object.fromEntries(
      (await repository.getEnvironmentVariables(project.id, environment.id)).map(
        ({ key, value }) => [key, value]
      )
    );
    expect(values).toEqual({ KEEP: "old", NEW: "set" });
  }
);

postgresTest(
  "flag resolution is strict and organization overrides beat the global default",
  async ({ prisma }) => {
    expect(await emptyEnvironmentVariableValuesEnabled(undefined, prisma)).toBe(false);
    expect(
      await emptyEnvironmentVariableValuesEnabled(
        { allowEmptyEnvironmentVariableValues: "true" },
        prisma
      )
    ).toBe(false);
    await prisma.featureFlag.create({
      data: { key: "allowEmptyEnvironmentVariableValues", value: true },
    });
    expect(await emptyEnvironmentVariableValuesEnabled(undefined, prisma)).toBe(true);
    expect(
      await emptyEnvironmentVariableValuesEnabled(
        { allowEmptyEnvironmentVariableValues: false },
        prisma
      )
    ).toBe(false);
  }
);
