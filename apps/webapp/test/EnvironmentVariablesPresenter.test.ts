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
import { EnvironmentVariablesPresenter } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  createEnvironmentVariable,
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

describe("EnvironmentVariablesPresenter", () => {
  postgresTest(
    "keeps secret values redacted while returning non-secret values",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
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

      const result = await new EnvironmentVariablesPresenter(prisma, prisma).call({
        userId: user.id,
        projectId: project.id,
      });

      const secretVariable = result.environmentVariables.find(
        (variable) => variable.key === "SECRET_VAR"
      );
      const nonSecretVariable = result.environmentVariables.find(
        (variable) => variable.key === "PLAIN_VAR"
      );

      expect(secretVariable).toBeDefined();
      expect(nonSecretVariable).toBeDefined();
      expect(secretVariable!.value).toBe("");
      expect(nonSecretVariable!.value).toBe("plain-value");
    }
  );

  postgresTest(
    "returns values for active environments (including branch environments) and excludes archived branch environments",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);

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

      const result = await new EnvironmentVariablesPresenter(prisma, prisma).call({
        userId: user.id,
        projectId: project.id,
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

  // Catches: counts and pages that ignore the environment filter, and a filter that doesn't
  // follow the URL environment, its branch, or an archived branch.
  postgresTest("lists and counts only the filtered environments", async ({ prisma }) => {
    const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
    const env = (type: "PRODUCTION" | "PREVIEW", slug: string) =>
      createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type,
        slug,
      });

    const prod = await env("PRODUCTION", "prod");
    const preview = await env("PREVIEW", "preview");
    await prisma.runtimeEnvironment.update({
      where: { id: preview.id },
      data: { isBranchableEnvironment: true },
    });
    const branch = async (slug: string, branchName: string) => {
      const created = await env("PREVIEW", slug);
      await prisma.runtimeEnvironment.update({
        where: { id: created.id },
        data: { parentEnvironmentId: preview.id, branchName },
      });
      return created;
    };
    const branchA = await branch("preview-a", "feature/a");
    const branchB = await branch("preview-b", "feature/b");
    const archived = await branch("preview-old", "feature/old");

    const repository = new EnvironmentVariablesRepository(prisma, prisma);
    const set = (environmentId: string, key: string) =>
      createEnvironmentVariable(repository, project.id, {
        environmentId,
        key,
        value: key.toLowerCase(),
        userId: user.id,
      });
    await set(prod.id, "PROD_ONLY");
    await set(preview.id, "PREVIEW_BASE");
    await set(branchA.id, "BRANCH_A");
    await set(branchB.id, "BRANCH_B");
    await set(archived.id, "ARCHIVED_ONLY");
    await prisma.runtimeEnvironment.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });

    const presenter = new EnvironmentVariablesPresenter(prisma, prisma);
    const call = (args: Partial<Parameters<typeof presenter.call>[0]>) =>
      presenter.call({ userId: user.id, projectId: project.id, ...args });
    const keys = (result: Awaited<ReturnType<typeof call>>) =>
      [...new Set(result.environmentVariables.map((variable) => variable.key))].sort();

    const fromProd = await call({ currentEnvironmentSlug: "prod" });
    expect(fromProd.filter).toBe("prod");
    expect(keys(fromProd)).toEqual(["PROD_ONLY"]);
    expect(fromProd.pagination.totalCount).toBe(1);
    // Every environment is still returned for the filter options and the create dialog.
    expect(fromProd.environments.map((e) => e.id)).toContain(branchA.id);

    const previewAll = await call({ currentEnvironmentSlug: "prod", environmentFilter: "preview" });
    expect(keys(previewAll)).toEqual(["BRANCH_A", "BRANCH_B", "PREVIEW_BASE"]);
    expect(previewAll.pagination.totalCount).toBe(3);
    expect(previewAll.filterBranchEnvironmentIds).toEqual([]);

    const oneBranch = await call({
      currentEnvironmentSlug: "prod",
      environmentFilter: "preview",
      branches: ["feature/b"],
    });
    expect(keys(oneBranch)).toEqual(["BRANCH_B", "PREVIEW_BASE"]);
    expect(oneBranch.pagination.totalCount).toBe(2);
    expect(oneBranch.filterBranchEnvironmentIds).toEqual([branchB.id]);

    const onBranchUrl = await call({ currentEnvironmentSlug: "preview-a" });
    expect(onBranchUrl.filter).toBe("preview");
    expect(keys(onBranchUrl)).toEqual(["BRANCH_A", "PREVIEW_BASE"]);

    const onArchivedUrl = await call({ currentEnvironmentSlug: "preview-old" });
    expect(onArchivedUrl.filter).toBe("preview");
    expect(keys(onArchivedUrl)).toEqual(["BRANCH_A", "BRANCH_B", "PREVIEW_BASE"]);

    const searched = await call({
      currentEnvironmentSlug: "prod",
      environmentFilter: "all",
      search: "branch",
    });
    expect(keys(searched)).toEqual(["BRANCH_A", "BRANCH_B"]);
    expect(searched.pagination.totalCount).toBe(2);
  });

  // Catches: a project with no variables showing "No variables in Prod yet" instead of the
  // first-run empty state, and a filtered view with nothing in it claiming the project is empty.
  postgresTest("reports a project with no variables whatever the filter is", async ({ prisma }) => {
    const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
    const env = (type: "PRODUCTION" | "STAGING", slug: string) =>
      createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type,
        slug,
      });
    await env("PRODUCTION", "prod");
    const staging = await env("STAGING", "stg");

    const presenter = new EnvironmentVariablesPresenter(prisma, prisma);
    const call = (args: Partial<Parameters<typeof presenter.call>[0]>) =>
      presenter.call({ userId: user.id, projectId: project.id, ...args });

    const empty = await call({ currentEnvironmentSlug: "prod" });
    expect(empty.filter).toBe("prod");
    expect(empty.projectHasNoVariables).toBe(true);
    expect((await call({ environmentFilter: "all" })).projectHasNoVariables).toBe(true);

    await createEnvironmentVariable(
      new EnvironmentVariablesRepository(prisma, prisma),
      project.id,
      {
        environmentId: staging.id,
        key: "STAGING_ONLY",
        value: "value",
        userId: user.id,
      }
    );

    const emptyFilter = await call({ currentEnvironmentSlug: "prod" });
    expect(emptyFilter.pagination.totalCount).toBe(0);
    expect(emptyFilter.projectHasNoVariables).toBe(false);
    // A search with no match is never the first-run state.
    const noMatch = await call({ environmentFilter: "all", search: "nothing" });
    expect(noMatch.pagination.totalCount).toBe(0);
    expect(noMatch.projectHasNoVariables).toBe(false);
  });
});
