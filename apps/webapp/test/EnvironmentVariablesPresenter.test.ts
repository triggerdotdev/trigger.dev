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
      typeof nameOrFn === "string"
        ? (fnOrOptions as (tx: unknown) => Promise<unknown>)
        : nameOrFn;

    return prismaClient.$transaction(fn);
  },
}));

import { postgresTest } from "@internal/testcontainers";
import { EnvironmentVariablesPresenter } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  createEnvironmentVariable,
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

describe("EnvironmentVariablesPresenter", () => {
  postgresTest("keeps secret values redacted while returning non-secret values", async ({ prisma }) => {
    const { user, organization, project, projectSlug } = await createTestOrgProjectWithMember(prisma);
    const production = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    const repository = new EnvironmentVariablesRepository(prisma, prisma);

    await createEnvironmentVariable(repository, project.id, {
      environmentId: production.id,
      key: "SECRET_VAR",
      value: "super-secret",
      isSecret: true,
      userId: user.id,
    });
    await createEnvironmentVariable(repository, project.id, {
      environmentId: production.id,
      key: "PLAIN_VAR",
      value: "plain-value",
      isSecret: false,
      userId: user.id,
    });

    const result = await new EnvironmentVariablesPresenter(prisma).call({
      userId: user.id,
      projectSlug,
    });

    const secretVariable = result.environmentVariables.find((variable) => variable.key === "SECRET_VAR");
    const nonSecretVariable = result.environmentVariables.find((variable) => variable.key === "PLAIN_VAR");

    expect(secretVariable).toBeDefined();
    expect(nonSecretVariable).toBeDefined();
    expect(secretVariable!.value).toBe("");
    expect(nonSecretVariable!.value).toBe("plain-value");
  });

  postgresTest(
    "returns values for active environments (including branch environments) and excludes archived branch environments",
    async ({ prisma }) => {
      const { user, organization, project, projectSlug } =
        await createTestOrgProjectWithMember(prisma);

      const prodEnvironment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });

      const parentPreviewEnvironment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PREVIEW",
      });
      await prisma.runtimeEnvironment.update({
        where: { id: parentPreviewEnvironment.id },
        data: { isBranchableEnvironment: true },
      });

      const activeBranchEnvironment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PREVIEW",
      });
      await prisma.runtimeEnvironment.update({
        where: { id: activeBranchEnvironment.id },
        data: {
          parentEnvironmentId: parentPreviewEnvironment.id,
          branchName: "feature/active",
        },
      });

      const archivedBranchEnvironment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PREVIEW",
      });
      await prisma.runtimeEnvironment.update({
        where: { id: archivedBranchEnvironment.id },
        data: {
          parentEnvironmentId: parentPreviewEnvironment.id,
          branchName: "feature/archived",
        },
      });

      const repository = new EnvironmentVariablesRepository(prisma, prisma);

      await createEnvironmentVariable(repository, project.id, {
        environmentId: prodEnvironment.id,
        key: "MY_VAR",
        value: "prod-value",
        userId: user.id,
      });
      await createEnvironmentVariable(repository, project.id, {
        environmentId: activeBranchEnvironment.id,
        key: "MY_VAR",
        value: "active-branch-value",
        userId: user.id,
      });
      await createEnvironmentVariable(repository, project.id, {
        environmentId: archivedBranchEnvironment.id,
        key: "MY_VAR",
        value: "archived-branch-value",
        userId: user.id,
      });

      // Archive the branch after it accumulated values (archiving does not
      // delete its EnvironmentVariableValue rows).
      await prisma.runtimeEnvironment.update({
        where: { id: archivedBranchEnvironment.id },
        data: { archivedAt: new Date() },
      });

      const result = await new EnvironmentVariablesPresenter(prisma).call({
        userId: user.id,
        projectSlug,
      });

      const environmentIds = result.environments.map((environment) => environment.id);
      expect(environmentIds).toContain(prodEnvironment.id);
      expect(environmentIds).toContain(activeBranchEnvironment.id);
      expect(environmentIds).not.toContain(archivedBranchEnvironment.id);

      const myVarValues = result.environmentVariables.filter(
        (variable) => variable.key === "MY_VAR"
      );
      expect(myVarValues).toHaveLength(2);

      const prodValue = myVarValues.find(
        (variable) => variable.environment.id === prodEnvironment.id
      );
      expect(prodValue?.value).toBe("prod-value");

      const activeBranchValue = myVarValues.find(
        (variable) => variable.environment.id === activeBranchEnvironment.id
      );
      expect(activeBranchValue?.value).toBe("active-branch-value");
      expect(activeBranchValue?.environment.branchName).toBe("feature/active");

      expect(
        myVarValues.some((variable) => variable.environment.id === archivedBranchEnvironment.id)
      ).toBe(false);
    }
  );
});
