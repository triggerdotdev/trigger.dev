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
import {
  deleteEnvironmentVariableValueRows,
  EnvironmentVariablesRepository,
} from "~/v3/environmentVariables/environmentVariablesRepository.server";
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

describe("EnvironmentVariablesRepository value deletes", () => {
  const vercel = { type: "integration" as const, integration: "vercel" };

  async function createBranchWithParent(
    prisma: Parameters<typeof createBaseOrgProjectWithMember>[0]
  ) {
    const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
    const parent = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PREVIEW",
    });
    const branch = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PREVIEW",
      parentEnvironmentId: parent.id,
    });
    const repository = new EnvironmentVariablesRepository(prisma, prisma);

    const write = async (
      environmentId: string,
      variables: Record<string, string>,
      lastUpdatedBy?: Parameters<typeof repository.create>[1]["lastUpdatedBy"]
    ) => {
      const result = await repository.create(project.id, {
        override: true,
        environmentIds: [environmentId],
        variables: Object.entries(variables).map(([key, value]) => ({ key, value })),
        lastUpdatedBy,
      });
      expect(result.success).toBe(true);
    };

    const ownKeys = async (environmentId: string) => {
      const values = await prisma.environmentVariableValue.findMany({
        where: { environmentId, variable: { projectId: project.id } },
        select: { variable: { select: { key: true } } },
      });
      return values.map((v) => v.variable.key).sort();
    };

    const variableKeys = async () =>
      (await prisma.environmentVariable.findMany({ where: { projectId: project.id } }))
        .map((v) => v.key)
        .sort();

    const secretRows = async (environmentId: string) => {
      const prefix = `environmentvariable:${project.id}:${environmentId}:`;
      const store = await prisma.secretStore.findMany({ where: { key: { startsWith: prefix } } });
      const references = await prisma.secretReference.findMany({
        where: { key: { startsWith: prefix } },
      });
      return {
        store: store.map((s) => s.key.slice(prefix.length)).sort(),
        references: references.map((r) => r.key.slice(prefix.length)).sort(),
      };
    };

    return { user, project, parent, branch, repository, write, ownKeys, variableKeys, secretRows };
  }

  postgresTest("removes several values with their secrets and references", async ({ prisma }) => {
    const { project, branch, repository, write, ownKeys, variableKeys, secretRows } =
      await createBranchWithParent(prisma);
    await write(branch.id, { A: "a", B: "b", C: "c" }, vercel);

    const result = await repository.deleteValues(project.id, {
      environmentId: branch.id,
      keys: ["A", "B", "A", "MISSING"],
    });

    expect(result).toEqual({ deleted: ["A", "B"], skipped: ["MISSING"] });
    expect(await ownKeys(branch.id)).toEqual(["C"]);
    expect(await variableKeys()).toEqual(["C"]);
    expect(await secretRows(branch.id)).toEqual({ store: ["C"], references: ["C"] });
    expect(await repository.getEnvironmentVariables(project.id, branch.id)).toEqual([
      { key: "C", value: "c" },
    ]);
  });

  postgresTest("onlyWrittenBy keeps values last written by anyone else", async ({ prisma }) => {
    const { user, project, branch, repository, write, ownKeys } =
      await createBranchWithParent(prisma);
    const other = await prisma.user.create({
      data: { email: `${branch.id}@test.com`, authenticationMethod: "MAGIC_LINK" },
    });
    await write(branch.id, { MINE: "m" }, vercel);
    await write(branch.id, { BY_OTHER: "o" }, { type: "integration", integration: "other" });
    await write(branch.id, { BY_NOBODY: "n" });
    await write(branch.id, { BY_ME: "u" }, { type: "user", userId: user.id });
    await write(branch.id, { BY_THEM: "t" }, { type: "user", userId: other.id });
    const keys = ["MINE", "BY_OTHER", "BY_NOBODY", "BY_ME", "BY_THEM"];

    expect(
      await repository.deleteValues(project.id, {
        environmentId: branch.id,
        keys,
        onlyWrittenBy: vercel,
      })
    ).toEqual({ deleted: ["MINE"], skipped: ["BY_OTHER", "BY_NOBODY", "BY_ME", "BY_THEM"] });
    expect(
      await repository.deleteValues(project.id, {
        environmentId: branch.id,
        keys,
        onlyWrittenBy: { type: "user", userId: user.id },
      })
    ).toEqual({ deleted: ["BY_ME"], skipped: ["MINE", "BY_OTHER", "BY_NOBODY", "BY_THEM"] });
    expect(await ownKeys(branch.id)).toEqual(["BY_NOBODY", "BY_OTHER", "BY_THEM"]);
  });

  postgresTest(
    "onlyShadowingParent removes only values the parent also holds",
    async ({ prisma }) => {
      const { project, parent, branch, repository, write, ownKeys, variableKeys } =
        await createBranchWithParent(prisma);
      await write(branch.id, { SHARED: "branch-copy", BRANCH_ONLY: "branch" }, vercel);
      await write(parent.id, { SHARED: "root", PARENT_ONLY: "root" }, vercel);

      const result = await repository.deleteValues(project.id, {
        environmentId: branch.id,
        keys: ["SHARED", "BRANCH_ONLY", "PARENT_ONLY"],
        onlyShadowingParent: true,
      });

      expect(result).toEqual({ deleted: ["SHARED"], skipped: ["BRANCH_ONLY", "PARENT_ONLY"] });
      expect(await ownKeys(branch.id)).toEqual(["BRANCH_ONLY"]);
      expect(await ownKeys(parent.id)).toEqual(["PARENT_ONLY", "SHARED"]);
      expect(await variableKeys()).toEqual(["BRANCH_ONLY", "PARENT_ONLY", "SHARED"]);
      expect(
        Object.fromEntries(
          (await repository.getEnvironmentVariables(project.id, branch.id, parent.id)).map(
            ({ key, value }) => [key, value]
          )
        )
      ).toEqual({ SHARED: "root", BRANCH_ONLY: "branch", PARENT_ONLY: "root" });

      expect(
        await repository.deleteValues(project.id, {
          environmentId: parent.id,
          keys: ["PARENT_ONLY"],
          onlyShadowingParent: true,
        })
      ).toEqual({ deleted: [], skipped: ["PARENT_ONLY"] });
      expect(await ownKeys(parent.id)).toEqual(["PARENT_ONLY", "SHARED"]);
    }
  );

  postgresTest(
    "removes a variable with its last value but keeps one the parent still uses",
    async ({ prisma }) => {
      const { project, parent, branch, repository, write, variableKeys } =
        await createBranchWithParent(prisma);
      await write(branch.id, { LAST: "l", BOTH: "b" }, vercel);
      await write(parent.id, { BOTH: "root" }, vercel);

      expect(
        await repository.deleteValues(project.id, {
          environmentId: branch.id,
          keys: ["LAST", "BOTH"],
        })
      ).toEqual({ deleted: ["LAST", "BOTH"], skipped: [] });
      expect(await variableKeys()).toEqual(["BOTH"]);
      expect(await repository.getEnvironmentVariables(project.id, parent.id)).toEqual([
        { key: "BOTH", value: "root" },
      ]);
    }
  );

  postgresTest(
    "skips a value whose version changed and cleans nothing for it",
    async ({ prisma }) => {
      const { project, branch, repository, write, ownKeys, secretRows, variableKeys } =
        await createBranchWithParent(prisma);
      await write(branch.id, { STALE: "s", FRESH: "f" }, vercel);
      const values = await prisma.environmentVariableValue.findMany({
        where: { environmentId: branch.id },
        select: {
          id: true,
          version: true,
          variableId: true,
          variable: { select: { key: true } },
          valueReference: { select: { key: true } },
        },
      });
      const rows = values.map((value) => ({
        id: value.id,
        version: value.variable.key === "STALE" ? value.version + 1 : value.version,
        variableId: value.variableId,
        environmentId: branch.id,
        key: value.variable.key,
        secretReferenceKey: value.valueReference?.key,
      }));

      const result = await prisma.$transaction((tx) =>
        deleteEnvironmentVariableValueRows(tx, project.id, rows)
      );

      expect(result.deleted.map((r) => r.key)).toEqual(["FRESH"]);
      expect(result.skipped.map((r) => r.key)).toEqual(["STALE"]);
      expect(await ownKeys(branch.id)).toEqual(["STALE"]);
      expect(await variableKeys()).toEqual(["STALE"]);
      expect(await secretRows(branch.id)).toEqual({ store: ["STALE"], references: ["STALE"] });
      expect(await repository.getEnvironmentVariables(project.id, branch.id)).toEqual([
        { key: "STALE", value: "s" },
      ]);
    }
  );

  postgresTest("does not reach into another project's variables", async ({ prisma }) => {
    const mine = await createBranchWithParent(prisma);
    const theirs = await createBranchWithParent(prisma);
    await theirs.write(theirs.branch.id, { SHARED: "b" }, vercel);
    await theirs.write(theirs.parent.id, { SHARED: "root" }, vercel);

    expect(
      await mine.repository.deleteValues(mine.project.id, {
        environmentId: theirs.branch.id,
        keys: ["SHARED"],
      })
    ).toEqual({ deleted: [], skipped: ["SHARED"] });
    expect(
      await mine.repository.deleteValues(mine.project.id, {
        environmentId: theirs.branch.id,
        keys: ["SHARED"],
        onlyShadowingParent: true,
      })
    ).toEqual({ deleted: [], skipped: ["SHARED"] });
    expect(await theirs.ownKeys(theirs.branch.id)).toEqual(["SHARED"]);
  });
  postgresTest("skips duplicate keys and keys whose row is already gone", async ({ prisma }) => {
    const { project, branch, repository, write, ownKeys } = await createBranchWithParent(prisma);
    await write(branch.id, { GONE: "g", KEPT: "k" }, vercel);
    await prisma.environmentVariableValue.deleteMany({
      where: { environmentId: branch.id, variable: { key: "GONE" } },
    });

    expect(
      await repository.deleteValues(project.id, {
        environmentId: branch.id,
        keys: ["GONE", "GONE", "KEPT", "KEPT", "NEVER"],
      })
    ).toEqual({ deleted: ["KEPT"], skipped: ["GONE", "NEVER"] });
    expect(await ownKeys(branch.id)).toEqual([]);
  });

  postgresTest(
    "deleteValue removes the variable with its last value and its secret rows",
    async ({ prisma }) => {
      const { project, branch, repository, write, variableKeys, secretRows } =
        await createBranchWithParent(prisma);
      await write(branch.id, { ONLY: "o", OTHER: "x" }, vercel);
      const variable = await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: project.id, key: "ONLY" },
      });

      expect(
        await repository.deleteValue(project.id, { id: variable.id, environmentId: branch.id })
      ).toEqual({ success: true });
      expect(await variableKeys()).toEqual(["OTHER"]);
      expect(await secretRows(branch.id)).toEqual({ store: ["OTHER"], references: ["OTHER"] });
      expect(
        await repository.deleteValue(project.id, { id: variable.id, environmentId: branch.id })
      ).toEqual({ success: false, error: "Environment variable not found" });
    }
  );

  postgresTest(
    "deleteValue keeps the value the variable has in another environment",
    async ({ prisma }) => {
      const { project, parent, branch, repository, write, ownKeys, variableKeys, secretRows } =
        await createBranchWithParent(prisma);
      await write(branch.id, { BOTH: "branch" }, vercel);
      await write(parent.id, { BOTH: "root" }, vercel);
      const variable = await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: project.id, key: "BOTH" },
      });

      expect(
        await repository.deleteValue(project.id, { id: variable.id, environmentId: branch.id })
      ).toEqual({ success: true });
      expect(await variableKeys()).toEqual(["BOTH"]);
      expect(await ownKeys(branch.id)).toEqual([]);
      expect(await ownKeys(parent.id)).toEqual(["BOTH"]);
      expect(await secretRows(branch.id)).toEqual({ store: [], references: [] });
      expect(await secretRows(parent.id)).toEqual({ store: ["BOTH"], references: ["BOTH"] });
      expect(await repository.getEnvironmentVariables(project.id, branch.id, parent.id)).toEqual([
        { key: "BOTH", value: "root" },
      ]);
      expect(
        await repository.deleteValue(project.id, { id: variable.id, environmentId: branch.id })
      ).toEqual({ success: false, error: "Environment variable value not found" });
    }
  );

  postgresTest("deleteValue handles a value without a secret reference", async ({ prisma }) => {
    const { project, branch, repository, write, variableKeys, secretRows } =
      await createBranchWithParent(prisma);
    await write(branch.id, { UNLINKED: "u" }, vercel);
    const variable = await prisma.environmentVariable.findFirstOrThrow({
      where: { projectId: project.id, key: "UNLINKED" },
    });
    await prisma.environmentVariableValue.updateMany({
      where: { variableId: variable.id, environmentId: branch.id },
      data: { valueReferenceId: null },
    });

    expect(
      await repository.deleteValue(project.id, { id: variable.id, environmentId: branch.id })
    ).toEqual({ success: true });
    expect(await variableKeys()).toEqual([]);
    expect((await secretRows(branch.id)).store).toEqual([]);
  });

  postgresTest("deletes three of four keys through a padded row list", async ({ prisma }) => {
    const { project, branch, repository, write, ownKeys, secretRows } =
      await createBranchWithParent(prisma);
    await write(branch.id, { A: "a", B: "b", C: "c", D: "d" }, vercel);

    expect(
      await repository.deleteValues(project.id, { environmentId: branch.id, keys: ["A", "B", "C"] })
    ).toEqual({ deleted: ["A", "B", "C"], skipped: [] });
    expect(await ownKeys(branch.id)).toEqual(["D"]);
    expect(await secretRows(branch.id)).toEqual({ store: ["D"], references: ["D"] });
    expect(await repository.getEnvironmentVariables(project.id, branch.id)).toEqual([
      { key: "D", value: "d" },
    ]);
  });
});
