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
import type { PrismaClient } from "@trigger.dev/database";
import { EnvironmentVariableKeyPresenter } from "~/presenters/v3/EnvironmentVariableKeyPresenter.server";
import { EnvironmentKeyUnavailableError } from "~/services/environmentEncryption/wrapping.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  createEnvironmentVariable,
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

async function createProject(prisma: PrismaClient) {
  const { user, organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
  const create = (
    type: "DEVELOPMENT" | "STAGING" | "PREVIEW" | "PRODUCTION",
    orgMemberId?: string
  ) =>
    createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type,
      orgMemberId,
    });

  const production = await create("PRODUCTION");
  const staging = await create("STAGING");
  const development = await create("DEVELOPMENT", orgMember.id);
  const preview = await create("PREVIEW");
  await prisma.runtimeEnvironment.update({
    where: { id: preview.id },
    data: { isBranchableEnvironment: true },
  });

  const createBranch = async (branchName: string) => {
    const branch = await create("PREVIEW");
    return prisma.runtimeEnvironment.update({
      where: { id: branch.id },
      data: { parentEnvironmentId: preview.id, branchName },
    });
  };

  const repository = new EnvironmentVariablesRepository(prisma, prisma);
  const set = (environmentId: string, key: string, value: string, isSecret = false) =>
    createEnvironmentVariable(repository, project.id, {
      environmentId,
      key,
      value,
      isSecret,
      userId: user.id,
    });

  return {
    user,
    project,
    repository,
    production,
    staging,
    development,
    preview,
    createBranch,
    set,
  };
}

describe("EnvironmentVariableKeyPresenter", () => {
  postgresTest(
    "lists the key's value in each environment in filter order, with a row for the ones where it isn't set",
    async ({ prisma }) => {
      const { user, project, production, staging, development, preview, set } =
        await createProject(prisma);

      await set(production.id, "DATABASE_URL", "postgres://prod");
      await set(staging.id, "DATABASE_URL", "postgres://staging", true);
      await set(production.id, "OTHER_KEY", "other");

      const detail = await new EnvironmentVariableKeyPresenter(prisma, prisma).call({
        userId: user.id,
        projectId: project.id,
        key: "DATABASE_URL",
      });

      expect(detail.exists).toBe(true);
      // Catches: rows out of the filter's order, or a missing row where the key isn't set.
      expect(detail.environments.map((row) => row.environment.id)).toEqual([
        development.id,
        staging.id,
        preview.id,
        production.id,
      ]);

      const [dev, stg, previewBase, prod] = detail.environments;
      expect(dev!.variable).toBeNull();
      expect(previewBase!.variable).toBeNull();
      expect(prod!.variable).toMatchObject({ key: "DATABASE_URL", value: "postgres://prod" });
      expect(prod!.variable!.updatedByUser?.id).toBe(user.id);
      // Catches: a secret value read back to the panel.
      expect(stg!.variable).toMatchObject({ isSecret: true, value: "" });

      expect(detail.counts).toEqual({
        previewBase: "unset",
        branchesSet: 0,
        branches: 0,
      });
      expect(detail.unsetBranches).toEqual([]);

      // Catches: a key from the URL with a null byte failing the query, which replaces the page
      // with an error, instead of reading as a key that isn't set.
      const presenter = new EnvironmentVariableKeyPresenter(prisma, prisma);
      const nullByteKey = { userId: user.id, projectId: project.id, key: "DATABASE\0URL" };
      expect(await presenter.call(nullByteKey)).toMatchObject({
        exists: false,
        key: "DATABASE\0URL",
        environments: [
          { variable: null },
          { variable: null },
          { variable: null },
          { variable: null },
        ],
      });
      expect(await presenter.isSet(nullByteKey)).toBe(false);
    }
  );

  postgresTest(
    "lists only the branches with their own value, searched by name and paged, and counts them all",
    async ({ prisma }) => {
      const { user, project, preview, createBranch, set } = await createProject(prisma);

      const names = ["feat/audit-log", "chore/audit-export", "fix/rate-limits", "feat/checkout"];
      const branches = await Promise.all(names.map(createBranch));
      const unset = await createBranch("feat/no-value");
      const archived = await createBranch("feat/audit-archived");

      await set(preview.id, "API_URL", "https://preview.example.com");
      for (const branch of [...branches, archived]) {
        await set(branch.id, "API_URL", `https://${branch.branchName}.example.com`);
      }
      // Archiving a branch keeps its values, so the presenter has to leave them out.
      await prisma.runtimeEnvironment.update({
        where: { id: archived.id },
        data: { archivedAt: new Date() },
      });

      const presenter = new EnvironmentVariableKeyPresenter(prisma, prisma);
      const call = (options: { branchSearch?: string; branchPage?: number }) =>
        presenter.call({
          userId: user.id,
          projectId: project.id,
          key: "API_URL",
          branchPageSize: 3,
          ...options,
        });

      const firstPage = await call({});
      // Catches: a branch without its own value, or an archived branch, listed or counted.
      expect(firstPage.counts).toEqual({
        previewBase: "set",
        branchesSet: 4,
        branches: 5,
      });
      expect(firstPage.branches.pagination).toEqual({
        currentPage: 1,
        totalPages: 2,
        totalCount: 4,
      });
      expect(firstPage.branches.variables.map((v) => v.environment.branchName)).toEqual([
        "chore/audit-export",
        "feat/audit-log",
        "feat/checkout",
      ]);
      expect(firstPage.branches.variables[0]!.value).toBe("https://chore/audit-export.example.com");

      const secondPage = await call({ branchPage: 2 });
      expect(secondPage.branches.variables.map((v) => v.environment.branchName)).toEqual([
        "fix/rate-limits",
      ]);
      expect(secondPage.branches.variables.map((v) => v.environment.id)).not.toContain(unset.id);

      // Catches: the search narrowing the summary counts, or matching on case.
      const searched = await call({ branchSearch: "AUDIT", branchPage: 5 });
      expect(searched.branches.variables.map((v) => v.environment.branchName)).toEqual([
        "chore/audit-export",
        "feat/audit-log",
      ]);
      expect(searched.branches.pagination).toEqual({
        currentPage: 1,
        totalPages: 1,
        totalCount: 2,
      });
      expect(searched.counts.branchesSet).toBe(4);
      // Catches: the branches an override can be added for listing one that already has a value,
      // an archived branch, or only the searched or paged ones.
      expect(searched.unsetBranches).toEqual([{ id: unset.id, branchName: "feat/no-value" }]);
      expect(firstPage.unsetBranches).toEqual(searched.unsetBranches);
    }
  );

  postgresTest(
    "reports a key with no value in a visible environment as not existing",
    async ({ prisma }) => {
      const { user, project, repository, production, createBranch, set } =
        await createProject(prisma);
      const presenter = new EnvironmentVariableKeyPresenter(prisma, prisma);
      const args = { userId: user.id, projectId: project.id };

      expect((await presenter.call({ ...args, key: "NOPE" })).exists).toBe(false);
      expect(await presenter.isSet({ ...args, key: "NOPE" })).toBe(false);

      const archived = await createBranch("feat/gone");
      await set(production.id, "ONLY_PROD", "value");
      await set(archived.id, "ONLY_PROD", "branch-value");
      await prisma.runtimeEnvironment.update({
        where: { id: archived.id },
        data: { archivedAt: new Date() },
      });
      expect(await presenter.isSet({ ...args, key: "ONLY_PROD" })).toBe(true);

      const variable = await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: project.id, key: "ONLY_PROD" },
      });
      await repository.deleteValue(project.id, {
        id: variable.id,
        environmentId: production.id,
      });

      // Catches: the panel staying open on a key whose only value left is on an archived branch.
      expect(await presenter.isSet({ ...args, key: "ONLY_PROD" })).toBe(false);
      expect((await presenter.call({ ...args, key: "ONLY_PROD" })).exists).toBe(false);
    }
  );

  postgresTest(
    "refuses a user who isn't a member of the project's organization",
    async ({ prisma }) => {
      const { project, production, set } = await createProject(prisma);
      const outsider = await createTestOrgProjectWithMember(prisma);
      await set(production.id, "DATABASE_URL", "postgres://prod");

      // Catches: one key's values read across organizations by project id.
      await expect(
        new EnvironmentVariableKeyPresenter(prisma, prisma).call({
          userId: outsider.user.id,
          projectId: project.id,
          key: "DATABASE_URL",
        })
      ).rejects.toThrow("Project not found");
    }
  );

  postgresTest(
    "keeps the row of an environment whose encryption key is unavailable, without its value",
    async ({ prisma }) => {
      const { user, project, production, staging, preview, createBranch, set } =
        await createProject(prisma);
      const branch = await createBranch("feat/one");

      await set(production.id, "DATABASE_URL", "postgres://prod");
      await set(staging.id, "DATABASE_URL", "postgres://staging");
      await set(preview.id, "DATABASE_URL", "postgres://preview", true);
      await set(branch.id, "DATABASE_URL", "postgres://branch");

      // Staging's and the branch's keys can't be used: any read that includes them fails.
      const unavailable = new Set([staging.id, branch.id]);
      const readValues = EnvironmentVariablesRepository.prototype.getVariableValuesForKeys;
      const spy = vi
        .spyOn(EnvironmentVariablesRepository.prototype, "getVariableValuesForKeys")
        .mockImplementation(async function (
          this: EnvironmentVariablesRepository,
          projectId,
          items
        ) {
          if (items.some((item) => unavailable.has(item.environmentId))) {
            throw new EnvironmentKeyUnavailableError();
          }
          return readValues.call(this, projectId, items);
        });

      try {
        const detail = await new EnvironmentVariableKeyPresenter(prisma, prisma).call({
          userId: user.id,
          projectId: project.id,
          key: "DATABASE_URL",
        });

        const row = (environmentId: string) =>
          detail.environments.find((r) => r.environment.id === environmentId)!.variable;

        // Catches: one unusable key failing the whole panel, or its row read as "not set".
        expect(row(staging.id)).toMatchObject({ value: "", valueUnavailable: true });
        expect(detail.branches.variables).toHaveLength(1);
        expect(detail.branches.variables[0]).toMatchObject({
          environment: { id: branch.id },
          value: "",
          valueUnavailable: true,
        });
        // Catches: the environments that can be read losing their values too.
        expect(row(production.id)).toMatchObject({ value: "postgres://prod" });
        expect(row(production.id)).not.toHaveProperty("valueUnavailable");
        // A secret is never read, so it isn't marked.
        expect(row(preview.id)).toMatchObject({ isSecret: true, value: "" });
        expect(row(preview.id)).not.toHaveProperty("valueUnavailable");
      } finally {
        spy.mockRestore();
      }
    }
  );

  postgresTest("fails on any other error while reading values", async ({ prisma }) => {
    const { user, project, production, set } = await createProject(prisma);
    await set(production.id, "DATABASE_URL", "postgres://prod");

    const spy = vi
      .spyOn(EnvironmentVariablesRepository.prototype, "getVariableValuesForKeys")
      .mockRejectedValue(new Error("connection lost"));

    try {
      // Catches: every read failure shown as an unavailable key.
      await expect(
        new EnvironmentVariableKeyPresenter(prisma, prisma).call({
          userId: user.id,
          projectId: project.id,
          key: "DATABASE_URL",
        })
      ).rejects.toThrow("connection lost");
    } finally {
      spy.mockRestore();
    }
  });
});
