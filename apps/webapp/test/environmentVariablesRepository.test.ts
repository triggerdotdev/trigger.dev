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
  enrollProxyOnlyValue,
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

describe("EnvironmentVariablesRepository.deleteValues", () => {
  // Catches: a batch that leaves a secret or its reference behind, deletes a value it wasn't
  // given, keeps a variable with no value left, or drops one that still has a value.
  postgresTest(
    "deletes exactly the named values with their secrets, and variables left with no value",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const [prod, staging] = await Promise.all(
        (["PRODUCTION", "STAGING"] as const).map((type) =>
          createRuntimeEnvironment(prisma, {
            projectId: project.id,
            organizationId: organization.id,
            type,
          })
        )
      );
      const repository = new EnvironmentVariablesRepository(prisma, prisma);
      const set = (key: string, environmentId: string) =>
        createEnvironmentVariable(repository, project.id, {
          environmentId,
          key,
          value: `${key}-value`,
          userId: user.id,
        });
      await set("BOTH", prod.id);
      await set("BOTH", staging.id);
      await set("PROD_ONLY", prod.id);
      await set("ALL_GONE", prod.id);
      await set("ALL_GONE", staging.id);
      const id = async (key: string) =>
        (
          await prisma.environmentVariable.findFirstOrThrow({
            where: { projectId: project.id, key },
          })
        ).id;

      const result = await repository.deleteValues(project.id, [
        { id: await id("BOTH"), environmentId: prod.id },
        { id: await id("PROD_ONLY"), environmentId: prod.id },
        { id: await id("ALL_GONE"), environmentId: prod.id },
        { id: await id("ALL_GONE"), environmentId: staging.id },
      ]);

      expect(result.success && result.deleted.map((value) => value.key).sort()).toEqual([
        "ALL_GONE",
        "ALL_GONE",
        "BOTH",
        "PROD_ONLY",
      ]);
      expect(await repository.getEnvironmentVariables(project.id, prod.id)).toEqual([]);
      expect(await repository.getEnvironmentVariables(project.id, staging.id)).toEqual([
        { key: "BOTH", value: "BOTH-value" },
      ]);
      expect(
        (await prisma.environmentVariable.findMany({ where: { projectId: project.id } })).map(
          (variable) => variable.key
        )
      ).toEqual(["BOTH"]);
      const remainingKey = `environmentvariable:${project.id}:${staging.id}:BOTH`;
      expect(
        (
          await prisma.secretStore.findMany({
            where: { key: { startsWith: `environmentvariable:${project.id}:` } },
          })
        ).map((secret) => secret.key)
      ).toEqual([remainingKey]);
      expect(
        (
          await prisma.secretReference.findMany({
            where: { key: { startsWith: `environmentvariable:${project.id}:` } },
          })
        ).map((reference) => reference.key)
      ).toEqual([remainingKey]);
    }
  );

  // Catches: a batch that fails because one of its values was deleted by someone else first, or
  // one that reaches a variable of another project by its id.
  postgresTest(
    "skips a value that is already gone and never touches another project",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const prod = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });
      const other = await createTestOrgProjectWithMember(prisma);
      const otherProd = await createRuntimeEnvironment(prisma, {
        projectId: other.project.id,
        organizationId: other.organization.id,
        type: "PRODUCTION",
      });
      const repository = new EnvironmentVariablesRepository(prisma, prisma);
      for (const key of ["GONE", "KEPT_ELSEWHERE", "HERE"]) {
        await createEnvironmentVariable(repository, project.id, {
          environmentId: prod.id,
          key,
          value: "x",
          userId: user.id,
        });
      }
      await createEnvironmentVariable(repository, other.project.id, {
        environmentId: otherProd.id,
        key: "THEIRS",
        value: "theirs",
        userId: other.user.id,
      });
      const variables = await prisma.environmentVariable.findMany({
        where: { projectId: { in: [project.id, other.project.id] } },
      });
      const id = (key: string) => variables.find((variable) => variable.key === key)!.id;
      await repository.deleteValue(project.id, { id: id("GONE"), environmentId: prod.id });

      const result = await repository.deleteValues(project.id, [
        { id: id("GONE"), environmentId: prod.id },
        { id: id("HERE"), environmentId: prod.id },
        { id: id("THEIRS"), environmentId: otherProd.id },
      ]);

      expect(result).toEqual({
        success: true,
        deleted: [{ id: id("HERE"), key: "HERE", environmentId: prod.id }],
      });
      expect(await repository.getEnvironmentVariables(project.id, prod.id)).toEqual([
        { key: "KEPT_ELSEWHERE", value: "x" },
      ]);
      expect(await repository.getEnvironmentVariables(other.project.id, otherProd.id)).toEqual([
        { key: "THEIRS", value: "theirs" },
      ]);
    }
  );

  // Catches: a batch that deletes a variable while another request is adding a value to it,
  // which takes the new value with it through the cascade.
  postgresTest(
    "keeps a variable that gains a value while the batch waits for it",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const [prod, staging] = await Promise.all(
        (["PRODUCTION", "STAGING"] as const).map((type) =>
          createRuntimeEnvironment(prisma, {
            projectId: project.id,
            organizationId: organization.id,
            type,
          })
        )
      );
      const repository = new EnvironmentVariablesRepository(prisma, prisma);
      await createEnvironmentVariable(repository, project.id, {
        environmentId: prod.id,
        key: "RACED",
        value: "x",
        userId: user.id,
      });
      const variable = await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: project.id, key: "RACED" },
      });

      // Another request adds a Staging value and hasn't committed when the batch starts.
      let commit!: () => void;
      const committed = new Promise<void>((resolve) => (commit = resolve));
      let inserted!: () => void;
      const hasInserted = new Promise<void>((resolve) => (inserted = resolve));
      const adding = prisma.$transaction(
        async (tx) => {
          await tx.environmentVariableValue.create({
            data: { variableId: variable.id, environmentId: staging.id },
          });
          inserted();
          await committed;
        },
        { timeout: 20_000 }
      );
      await hasInserted;
      const deleting = repository.deleteValues(project.id, [
        { id: variable.id, environmentId: prod.id },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 500));
      commit();
      await adding;

      expect(await deleting).toEqual({
        success: true,
        deleted: [{ id: variable.id, key: "RACED", environmentId: prod.id }],
      });
      expect(
        await prisma.environmentVariableValue.findMany({
          where: { variableId: variable.id },
          select: { environmentId: true },
        })
      ).toEqual([{ environmentId: staging.id }]);
    }
  );

  // Catches: two overlapping batches that both report the same values as deleted.
  postgresTest("overlapping batches count each value once", async ({ prisma }) => {
    const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
    const prod = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });
    const repository = new EnvironmentVariablesRepository(prisma, prisma);
    const keys = Array.from({ length: 20 }, (_, index) => `KEY_${index}`);
    for (const key of keys) {
      await createEnvironmentVariable(repository, project.id, {
        environmentId: prod.id,
        key,
        value: "x",
        userId: user.id,
      });
    }
    const values = (
      await prisma.environmentVariable.findMany({ where: { projectId: project.id } })
    ).map((variable) => ({ id: variable.id, environmentId: prod.id }));

    const results = await Promise.all([
      repository.deleteValues(project.id, values),
      repository.deleteValues(project.id, [...values].reverse()),
    ]);

    expect(
      results.reduce((sum, result) => sum + (result.success ? result.deleted.length : NaN), 0)
    ).toBe(keys.length);
    expect(await prisma.environmentVariable.count({ where: { projectId: project.id } })).toBe(0);
    expect(
      await prisma.secretStore.count({
        where: { key: { startsWith: `environmentvariable:${project.id}:` } },
      })
    ).toBe(0);
  });

  // Catches: a delete, single or batch, that removes a proxy-only value; a batch that deletes
  // its other values before refusing; and a batch refused because one of its keys is proxy-only
  // in an environment it isn't deleting from.
  postgresTest(
    "refuses a proxy-only value, all or nothing, and only where it is being deleted",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const [prod, staging] = await Promise.all(
        (["PRODUCTION", "STAGING"] as const).map((type) =>
          createRuntimeEnvironment(prisma, {
            projectId: project.id,
            organizationId: organization.id,
            type,
          })
        )
      );
      const repository = new EnvironmentVariablesRepository(prisma, prisma);
      for (const [key, environmentId] of [
        ["TOKEN", prod.id],
        ["TOKEN", staging.id],
        ["PLAIN", prod.id],
      ]) {
        await createEnvironmentVariable(repository, project.id, {
          environmentId,
          key,
          value: "x",
          userId: user.id,
        });
      }
      const variables = await prisma.environmentVariable.findMany({
        where: { projectId: project.id },
      });
      const id = (key: string) => variables.find((variable) => variable.key === key)!.id;
      await enrollProxyOnlyValue(prisma, {
        environmentId: prod.id,
        variableId: id("TOKEN"),
        allowedHosts: ["api.example.com"],
      });
      const remaining = async () =>
        (
          await prisma.environmentVariableValue.findMany({
            where: { variable: { projectId: project.id } },
            select: { environmentId: true, variable: { select: { key: true } } },
          })
        )
          .map((value) => `${value.variable.key}@${value.environmentId}`)
          .sort();
      const all = await remaining();
      const refused = { success: false, error: expect.stringContaining("Proxy-only") };

      expect(
        await repository.deleteValue(project.id, { id: id("TOKEN"), environmentId: prod.id })
      ).toMatchObject(refused);
      expect(
        await repository.deleteValues(project.id, [
          { id: id("PLAIN"), environmentId: prod.id },
          { id: id("TOKEN"), environmentId: prod.id },
        ])
      ).toMatchObject(refused);
      expect(await remaining()).toEqual(all);
      expect(
        await prisma.secretStore.count({
          where: { key: { startsWith: `environmentvariable:${project.id}:` } },
        })
      ).toBe(all.length);

      // TOKEN is proxy-only in Prod only: its Staging value deletes, also next to a Prod value.
      const result = await repository.deleteValues(project.id, [
        { id: id("TOKEN"), environmentId: staging.id },
        { id: id("PLAIN"), environmentId: prod.id },
      ]);
      expect(result.success && result.deleted.map((value) => value.key).sort()).toEqual([
        "PLAIN",
        "TOKEN",
      ]);
      expect(await remaining()).toEqual([`TOKEN@${prod.id}`]);
    }
  );

  // Catches: a batch delete and a save of the same keys each holding a row the other waits
  // for, which the database ends by failing one of them with a deadlock.
  postgresTest("racing saves of the same keys never deadlock with a batch", async ({ prisma }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);
    // With the flag on, every save takes the proxy-only check's lock on its variable first.
    await prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: { allowEmptyEnvironmentVariableValues: true, secretProxy: true } },
    });
    const [prod, staging] = await Promise.all(
      (["PRODUCTION", "STAGING"] as const).map((type) =>
        createRuntimeEnvironment(prisma, {
          projectId: project.id,
          organizationId: organization.id,
          type,
        })
      )
    );
    const repository = new EnvironmentVariablesRepository(prisma, prisma);
    const keys = Array.from({ length: 8 }, (_, index) => `KEY_${index}`);
    const environmentIds = [prod.id, staging.id];
    const create = (order: string[]) =>
      repository.create(project.id, {
        override: true,
        environmentIds,
        variables: order.map((key) => ({ key, value: "x" })),
      });

    for (let round = 0; round < 6; round++) {
      expect(await create(keys)).toMatchObject({ success: true });
      const variables = await prisma.environmentVariable.findMany({
        where: { projectId: project.id },
      });
      const batch = () =>
        repository.deleteValues(
          project.id,
          variables.flatMap(({ id }) =>
            environmentIds.map((environmentId) => ({ id, environmentId }))
          )
        );
      const saves = () => [
        create([...keys].reverse()),
        ...variables.map(({ id }) =>
          repository.edit(project.id, {
            id,
            values: [...environmentIds].reverse().map((environmentId) => ({
              environmentId,
              value: "y",
            })),
          })
        ),
      ];

      // Each side goes first in turn.
      const results = await Promise.all(
        round % 2 === 0 ? [batch(), ...saves()] : [...saves(), batch()]
      );

      // A save may lose to the delete: that is a conflict, or its variable is reported missing.
      // A deadlock is neither, it comes back as an unexplained failure.
      expect(
        results.filter(
          (result) =>
            !result.success &&
            !("conflict" in result && result.conflict) &&
            !/not found/i.test(result.error)
        )
      ).toEqual([]);
      await batch();
    }
  });
});

// Resolves once another connection is waiting on a row lock, so a test can force the order of
// two requests instead of sleeping and hoping.
async function waitForBlockedQuery(prisma: {
  $queryRaw: (query: TemplateStringsArray) => Promise<unknown>;
}) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const [{ blocked }] = (await prisma.$queryRaw`
      SELECT count(*)::int AS blocked FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`) as [{ blocked: number }];
    if (blocked > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("No query blocked on a lock");
}

describe("EnvironmentVariablesRepository.deleteValue", () => {
  // Catches: a single delete that decides "last value" before its transaction and then deletes
  // the whole variable, taking a value added meanwhile with it through the cascade.
  postgresTest(
    "keeps a variable that gains a value while the delete waits for it",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const [prod, staging] = await Promise.all(
        (["PRODUCTION", "STAGING"] as const).map((type) =>
          createRuntimeEnvironment(prisma, {
            projectId: project.id,
            organizationId: organization.id,
            type,
          })
        )
      );
      const repository = new EnvironmentVariablesRepository(prisma, prisma);
      await createEnvironmentVariable(repository, project.id, {
        environmentId: prod.id,
        key: "RACED",
        value: "x",
        userId: user.id,
      });
      const variable = await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: project.id, key: "RACED" },
      });

      // Another request adds a Staging value and hasn't committed when the delete starts.
      let commit!: () => void;
      const committed = new Promise<void>((resolve) => (commit = resolve));
      let inserted!: () => void;
      const hasInserted = new Promise<void>((resolve) => (inserted = resolve));
      const adding = prisma.$transaction(
        async (tx) => {
          await tx.environmentVariableValue.create({
            data: { variableId: variable.id, environmentId: staging.id },
          });
          inserted();
          await committed;
        },
        { timeout: 20_000 }
      );
      await hasInserted;
      const deleting = repository.deleteValue(project.id, {
        id: variable.id,
        environmentId: prod.id,
      });
      await waitForBlockedQuery(prisma);
      commit();
      await adding;

      expect(await deleting).toEqual({ success: true });
      expect(
        await prisma.environmentVariableValue.findMany({
          where: { variableId: variable.id },
          select: { environmentId: true },
        })
      ).toEqual([{ environmentId: staging.id }]);
    }
  );

  // Catches: a single delete that reports success for a value that was already gone, or loses
  // the difference between a missing value and a missing variable.
  postgresTest("reports a value or a variable that is already gone", async ({ prisma }) => {
    const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
    const [prod, staging] = await Promise.all(
      (["PRODUCTION", "STAGING"] as const).map((type) =>
        createRuntimeEnvironment(prisma, {
          projectId: project.id,
          organizationId: organization.id,
          type,
        })
      )
    );
    const repository = new EnvironmentVariablesRepository(prisma, prisma);
    for (const environmentId of [prod.id, staging.id]) {
      await createEnvironmentVariable(repository, project.id, {
        environmentId,
        key: "TWICE",
        value: "x",
        userId: user.id,
      });
    }
    const { id } = await prisma.environmentVariable.findFirstOrThrow({
      where: { projectId: project.id, key: "TWICE" },
    });

    expect(await repository.deleteValue(project.id, { id, environmentId: prod.id })).toEqual({
      success: true,
    });
    expect(await repository.deleteValue(project.id, { id, environmentId: prod.id })).toEqual({
      success: false,
      error: "Environment variable value not found",
    });
    expect(await repository.deleteValue(project.id, { id, environmentId: staging.id })).toEqual({
      success: true,
    });
    expect(await repository.deleteValue(project.id, { id, environmentId: staging.id })).toEqual({
      success: false,
      error: "Environment variable not found",
    });
    expect(
      await prisma.secretStore.count({
        where: { key: { startsWith: `environmentvariable:${project.id}:` } },
      })
    ).toBe(0);
  });
});

describe("EnvironmentVariablesRepository saves that lose a race", () => {
  // Catches: a create or edit that loses to a delete of the same variable and hands the caller
  // the database's own error text, with nothing to tell a conflict from a bad request.
  postgresTest(
    "a save that loses to a delete of its variable is a conflict in plain words",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const [prod, staging] = await Promise.all(
        (["PRODUCTION", "STAGING"] as const).map((type) =>
          createRuntimeEnvironment(prisma, {
            projectId: project.id,
            organizationId: organization.id,
            type,
          })
        )
      );
      const repository = new EnvironmentVariablesRepository(prisma, prisma);

      // The variable is deleted by a request that commits only once the save is waiting on it.
      const losesToDelete = async <T>(key: string, save: (variableId: string) => Promise<T>) => {
        await createEnvironmentVariable(repository, project.id, {
          environmentId: prod.id,
          key,
          value: "x",
          userId: user.id,
        });
        const variable = await prisma.environmentVariable.findFirstOrThrow({
          where: { projectId: project.id, key },
        });
        let commit!: () => void;
        const committed = new Promise<void>((resolve) => (commit = resolve));
        let deleted!: () => void;
        const hasDeleted = new Promise<void>((resolve) => (deleted = resolve));
        const deleting = prisma.$transaction(
          async (tx) => {
            await tx.environmentVariable.delete({ where: { id: variable.id } });
            deleted();
            await committed;
          },
          { timeout: 20_000 }
        );
        await hasDeleted;
        const saving = save(variable.id);
        await waitForBlockedQuery(prisma);
        commit();
        await deleting;
        return saving;
      };

      const results = [
        await losesToDelete("CREATED", () =>
          repository.create(project.id, {
            override: true,
            environmentIds: [staging.id],
            variables: [{ key: "CREATED", value: "y" }],
          })
        ),
        await losesToDelete("EDITED", (id) =>
          repository.edit(project.id, { id, values: [{ environmentId: staging.id, value: "y" }] })
        ),
        await losesToDelete("VALUE_EDITED", (id) =>
          repository.editValue(project.id, { id, environmentId: prod.id, value: "y" })
        ),
      ];

      for (const result of results) {
        expect(result).toMatchObject({ success: false, conflict: true });
        expect(JSON.stringify(result)).not.toMatch(/prisma|constraint|invocation|record/i);
      }
    }
  );
});
