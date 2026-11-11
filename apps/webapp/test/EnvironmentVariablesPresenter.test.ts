import { describe, expect, vi } from "vitest";

vi.mock("~/db.server", async () => ({
  prisma: {},
  sqlDatabaseSchema: (await import("@trigger.dev/database")).Prisma.sql([`public`]),
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
import type { PrismaClient } from "@trigger.dev/database";
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

  // Catches: the updated sort ordering only the current page, following another environment's
  // values, dropping the key search, or being applied to a view it isn't offered in.
  postgresTest(
    "sorts one environment's keys by last update across pages, and ignores the sort elsewhere",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const production = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PRODUCTION",
      });
      const staging = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "STAGING",
      });

      const repository = new EnvironmentVariablesRepository(prisma, prisma);
      // Production update times, oldest first: B_KEY, A_KEY, then C_KEY and D_KEY at the same
      // time. D_KEY is created before C_KEY, so the tied pair's id order isn't its key order.
      const productionTimes: Record<string, string> = {
        A_KEY: "2026-01-03T00:00:00Z",
        B_KEY: "2026-01-01T00:00:00Z",
        D_KEY: "2026-01-04T00:00:00Z",
        C_KEY: "2026-01-04T00:00:00Z",
      };
      for (const [key, time] of Object.entries(productionTimes)) {
        await createEnvironmentVariable(repository, project.id, {
          environmentId: production.id,
          key,
          value: `${key}-prod`,
          userId: user.id,
        });
        await setUpdatedAt(prisma, project.id, key, production.id, time);
      }
      // In Staging only B_KEY is recent.
      for (const [key, time] of [
        ["A_KEY", "2026-02-01T00:00:00Z"],
        ["B_KEY", "2026-03-01T00:00:00Z"],
      ]) {
        await createEnvironmentVariable(repository, project.id, {
          environmentId: staging.id,
          key,
          value: `${key}-stg`,
          userId: user.id,
        });
        await setUpdatedAt(prisma, project.id, key, staging.id, time);
      }
      // Ties are broken by variable id: ascending newest first, descending oldest first.
      const tied = await tiedKeysById(prisma, project.id, ["C_KEY", "D_KEY"]);

      const presenter = new EnvironmentVariablesPresenter(prisma, prisma);
      const keys = async (options: {
        environmentFilter: "prod" | "stg" | "all";
        sort?: "updated" | "updated-asc";
        page?: number;
        pageSize?: number;
        search?: string;
      }) => {
        const result = await presenter.call({ userId: user.id, projectId: project.id, ...options });
        return {
          keys: [...new Set(result.environmentVariables.map((variable) => variable.key))],
          totalCount: result.pagination.totalCount,
        };
      };

      expect((await keys({ environmentFilter: "prod" })).keys).toEqual([
        "A_KEY",
        "B_KEY",
        "C_KEY",
        "D_KEY",
      ]);
      expect(await keys({ environmentFilter: "prod", sort: "updated", pageSize: 3 })).toEqual({
        keys: [...tied, "A_KEY"],
        totalCount: 4,
      });
      expect(
        (await keys({ environmentFilter: "prod", sort: "updated", pageSize: 3, page: 2 })).keys
      ).toEqual(["B_KEY"]);
      // Oldest first is newest first read backward, across pages too.
      expect(
        (await keys({ environmentFilter: "prod", sort: "updated-asc", pageSize: 3 })).keys
      ).toEqual(["B_KEY", "A_KEY", tied[1]]);
      expect(
        (await keys({ environmentFilter: "prod", sort: "updated-asc", pageSize: 3, page: 2 })).keys
      ).toEqual([tied[0]]);
      expect((await keys({ environmentFilter: "stg", sort: "updated" })).keys).toEqual([
        "B_KEY",
        "A_KEY",
      ]);
      expect(await keys({ environmentFilter: "prod", sort: "updated", search: "c_k" })).toEqual({
        keys: ["C_KEY"],
        totalCount: 1,
      });
      // Catches: the sorted page matching a search's `_` or `%` differently from the count and
      // the alphabetical page, so the total and the rows disagree.
      for (const search of ["_", "%", "A_K", "C%Y", "AXK"]) {
        const alphabetical = await keys({ environmentFilter: "prod", search });
        const sorted = await keys({ environmentFilter: "prod", sort: "updated", search });
        expect(sorted.totalCount, search).toBe(alphabetical.totalCount);
        expect(sorted.keys.toSorted(), search).toEqual(alphabetical.keys);
        expect(sorted.keys.length, search).toBe(sorted.totalCount);
      }

      // Every environment at once can't be sorted: the sort is ignored, so the keys are
      // alphabetical and a key's rows keep the environment order.
      const all = await presenter.call({
        userId: user.id,
        projectId: project.id,
        environmentFilter: "all",
        sort: "updated",
      });
      expect([...new Set(all.environmentVariables.map((variable) => variable.key))]).toEqual([
        "A_KEY",
        "B_KEY",
        "C_KEY",
        "D_KEY",
      ]);
      expect(
        all.environmentVariables
          .filter((variable) => variable.key === "B_KEY")
          .map((variable) => variable.environment.type)
      ).toEqual(all.environments.map((environment) => environment.type));
    }
  );

  // Catches: a page built from each environment's newest values missing or misplacing a key
  // (set in both, in one only, tied), oldest first not going by a key's oldest value, and the
  // sort being applied to Preview with several branches.
  postgresTest(
    "sorts the Preview base plus one branch by each key's newest or oldest value",
    async ({ prisma }) => {
      const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
      const preview = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: organization.id,
        type: "PREVIEW",
        slug: "preview",
      });
      await prisma.runtimeEnvironment.update({
        where: { id: preview.id },
        data: { isBranchableEnvironment: true },
      });
      const createBranch = async (slug: string, branchName: string) => {
        const created = await createRuntimeEnvironment(prisma, {
          projectId: project.id,
          organizationId: organization.id,
          type: "PREVIEW",
          slug,
        });
        await prisma.runtimeEnvironment.update({
          where: { id: created.id },
          data: { parentEnvironmentId: preview.id, branchName },
        });
        return created;
      };
      const branch = await createBranch("preview-a", "feature/a");
      const otherBranch = await createBranch("preview-b", "feature/b");

      const repository = new EnvironmentVariablesRepository(prisma, prisma);
      const set = async (environmentId: string, key: string, day: number) => {
        await createEnvironmentVariable(repository, project.id, {
          environmentId,
          key,
          value: `${key}-${day}`,
          userId: user.id,
        });
        const time = `2026-01-${String(day).padStart(2, "0")}T00:00:00Z`;
        await setUpdatedAt(prisma, project.id, key, environmentId, time);
      };
      // Set in both, the branch value newer.
      await set(preview.id, "BOTH_BRANCH_NEWER", 1);
      await set(branch.id, "BOTH_BRANCH_NEWER", 9);
      // Set in both, the base value newer.
      await set(preview.id, "BOTH_BASE_NEWER", 8);
      await set(branch.id, "BOTH_BASE_NEWER", 2);
      await set(preview.id, "BASE_ONLY", 5);
      await set(branch.id, "BRANCH_ONLY", 6);
      // The same time, one in each environment.
      await set(branch.id, "TIE_BRANCH", 4);
      await set(preview.id, "TIE_BASE", 4);
      // The other branch's values are newer than everything and not in view.
      await set(otherBranch.id, "BASE_ONLY", 11);
      await set(otherBranch.id, "OTHER_BRANCH_ONLY", 10);
      const tied = await tiedKeysById(prisma, project.id, ["TIE_BASE", "TIE_BRANCH"]);

      const presenter = new EnvironmentVariablesPresenter(prisma, prisma);
      const call = (args: Partial<Parameters<typeof presenter.call>[0]>) =>
        presenter.call({
          userId: user.id,
          projectId: project.id,
          environmentFilter: "preview",
          branches: ["feature/a"],
          ...args,
        });
      const keys = async (args: Partial<Parameters<typeof presenter.call>[0]>) => [
        ...new Set((await call(args)).environmentVariables.map((variable) => variable.key)),
      ];
      const pages = async (sort: "updated" | "updated-asc") => [
        ...(await keys({ sort, pageSize: 2, page: 1 })),
        ...(await keys({ sort, pageSize: 2, page: 2 })),
        ...(await keys({ sort, pageSize: 2, page: 3 })),
      ];

      // Newest first: by each key's newest value in the base or the branch.
      const newestFirst = [
        "BOTH_BRANCH_NEWER",
        "BOTH_BASE_NEWER",
        "BRANCH_ONLY",
        "BASE_ONLY",
        ...tied,
      ];
      expect(await keys({ sort: "updated" })).toEqual(newestFirst);
      expect(await pages("updated")).toEqual(newestFirst);
      // Oldest first: by each key's oldest value, so a key set in both goes by its older one.
      const oldestFirst = [
        "BOTH_BRANCH_NEWER",
        "BOTH_BASE_NEWER",
        ...tied.toReversed(),
        "BASE_ONLY",
        "BRANCH_ONLY",
      ];
      expect(await keys({ sort: "updated-asc" })).toEqual(oldestFirst);
      expect(await pages("updated-asc")).toEqual(oldestFirst);
      expect(await keys({ sort: "updated", search: "both" })).toEqual([
        "BOTH_BRANCH_NEWER",
        "BOTH_BASE_NEWER",
      ]);
      expect(await keys({ sort: "updated-asc", search: "only" })).toEqual([
        "BASE_ONLY",
        "BRANCH_ONLY",
      ]);

      // Catches: a key placed by one value showing its other value on its top row.
      const rowEnvironments = async (sort: "updated" | "updated-asc", key: string) =>
        (await call({ sort })).environmentVariables
          .filter((variable) => variable.key === key)
          .map((variable) => variable.environment.id);
      expect(await rowEnvironments("updated", "BOTH_BRANCH_NEWER")).toEqual([
        branch.id,
        preview.id,
      ]);
      expect(await rowEnvironments("updated-asc", "BOTH_BRANCH_NEWER")).toEqual([
        preview.id,
        branch.id,
      ]);

      // Several branches or every branch can't be sorted: the sort is ignored.
      const alphabetical = [
        "BASE_ONLY",
        "BOTH_BASE_NEWER",
        "BOTH_BRANCH_NEWER",
        "BRANCH_ONLY",
        "OTHER_BRANCH_ONLY",
        "TIE_BASE",
        "TIE_BRANCH",
      ];
      expect(await keys({ sort: "updated", branches: ["feature/a", "feature/b"] })).toEqual(
        alphabetical
      );
      expect(await keys({ sort: "updated", branches: [] })).toEqual(alphabetical);
    }
  );
});

/** The keys in the order of their variable ids, which is how the sort breaks ties. */
async function tiedKeysById(prisma: PrismaClient, projectId: string, keys: string[]) {
  const variables = await prisma.environmentVariable.findMany({
    where: { projectId, key: { in: keys } },
    select: { id: true, key: true },
  });
  return variables.toSorted((a, b) => (a.id < b.id ? -1 : 1)).map((variable) => variable.key);
}

async function setUpdatedAt(
  prisma: PrismaClient,
  projectId: string,
  key: string,
  environmentId: string,
  time: string
) {
  const variable = await prisma.environmentVariable.findUniqueOrThrow({
    where: { projectId_key: { projectId, key } },
  });
  await prisma.environmentVariableValue.update({
    where: { variableId_environmentId: { variableId: variable.id, environmentId } },
    data: { updatedAt: new Date(time) },
  });
}
