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
import { EnvironmentVariablesAttentionPresenter } from "~/presenters/v3/EnvironmentVariablesAttentionPresenter.server";
import { EnvironmentVariablesPresenter } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import {
  AttentionIgnoreForm,
  type AttentionIgnoreItem,
  type AttentionView,
} from "~/v3/environmentVariables/attention";
import { setAttentionIgnores } from "~/v3/environmentVariables/attentionIgnores.server";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  createEnvironmentVariable,
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

async function setUp(prisma: PrismaClient) {
  const { user, organization, project } = await createTestOrgProjectWithMember(prisma);
  await prisma.organization.update({
    where: { id: organization.id },
    data: { featureFlags: { allowEmptyEnvironmentVariableValues: true } },
  });
  const env = (type: "PRODUCTION" | "STAGING", slug: string) =>
    createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type,
      slug,
    });
  const prod = await env("PRODUCTION", "prod");
  const staging = await env("STAGING", "stg");
  const repository = new EnvironmentVariablesRepository(prisma, prisma);
  const set = (environmentId: string, key: string, value: string) =>
    createEnvironmentVariable(repository, project.id, {
      environmentId,
      key,
      value,
      userId: user.id,
    });
  const variableId = async (key: string) =>
    (
      await prisma.environmentVariable.findFirstOrThrow({
        where: { projectId: project.id, key },
      })
    ).id;
  const ignore = (action: "ignore" | "unignore", items: AttentionIgnoreItem[]) =>
    setAttentionIgnores(prisma, {
      projectId: project.id,
      userId: user.id,
      action,
      items,
      canWrite: () => true,
    });
  const presenter = new EnvironmentVariablesAttentionPresenter(prisma, prisma);
  const view = async (env: string, kind?: AttentionView) => {
    const result = await presenter.call({ userId: user.id, projectId: project.id, env, kind });
    if (!result.isReadable) {
      throw new Error(`${env} should be readable`);
    }
    return result;
  };
  return { user, organization, project, prod, staging, repository, set, variableId, ignore, view };
}

describe("Ignoring needs attention reasons", () => {
  postgresTest(
    // Catches: an ignored reason still counted or listed, a row dropped with an un-ignored reason
    // it still has, or an ignore in one environment hiding the key in another.
    "leaves ignored reasons out of the tabs and counts, per environment, until undone",
    async ({ prisma }) => {
      const { user, project, prod, staging, set, variableId, ignore, view } = await setUp(prisma);
      await set(prod.id, "EMPTY_RECENT", "");
      await set(prod.id, "EMPTY_OLD", "");
      await set(staging.id, "EMPTY_OLD", "");
      await set(staging.id, "ONLY_STAGING", "value");
      await set(prod.id, "SET_EVERYWHERE", "value");
      await set(staging.id, "SET_EVERYWHERE", "value");
      // Age every value but EMPTY_RECENT in Prod past "Changed recently".
      await prisma.environmentVariableValue.updateMany({
        where: { variable: { key: { not: "EMPTY_RECENT" } } },
        data: { updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
      });

      const before = await view("prod");
      expect(before.counts).toEqual({
        empty: 2,
        missing: 1,
        recent: 1,
        oidc: 0,
        all: 3,
        ignored: 0,
      });

      const emptyRecent = await variableId("EMPTY_RECENT");
      const emptyOld = await variableId("EMPTY_OLD");
      const onlyStaging = await variableId("ONLY_STAGING");
      const result = await ignore("ignore", [
        { variableId: emptyRecent, environmentId: prod.id, reason: "empty" },
        { variableId: emptyOld, environmentId: prod.id, reason: "empty" },
        { variableId: onlyStaging, environmentId: prod.id, reason: "missing" },
        // Named twice: one ignore.
        { variableId: onlyStaging, environmentId: prod.id, reason: "missing" },
      ]);
      expect(result).toEqual({ success: true, changed: 3 });

      const after = await view("prod");
      expect(after.counts).toEqual({
        empty: 0,
        missing: 0,
        recent: 1,
        oidc: 0,
        all: 1,
        ignored: 3,
      });
      // Still changed recently, so it stays, with only that reason.
      expect(after.rows.map((row) => [row.key, row.kinds])).toEqual([["EMPTY_RECENT", ["recent"]]]);

      const ignored = await view("prod", "ignored");
      expect(ignored.pagination.totalCount).toBe(3);
      expect(
        ignored.rows.map((row) => [
          row.key,
          row.ignored.map((i) => [i.kind, i.createdBy?.name, i.createdAt instanceof Date]),
        ])
      ).toEqual([
        ["EMPTY_OLD", [["empty", user.name ?? "Unknown", true]]],
        ["EMPTY_RECENT", [["empty", user.name ?? "Unknown", true]]],
        ["ONLY_STAGING", [["missing", user.name ?? "Unknown", true]]],
      ]);

      // Staging's EMPTY_OLD is another environment's reason.
      expect((await view("stg", "empty")).rows.map((row) => row.key)).toEqual(["EMPTY_OLD"]);

      // The list's button leaves out the ignored Missing here key.
      const list = await new EnvironmentVariablesPresenter(prisma, prisma).call({
        userId: user.id,
        projectId: project.id,
        environmentFilter: "prod",
        canRead: () => true,
      });
      expect(list.attentionCount).toBe(1);

      // Undo brings the reasons back.
      expect(
        await ignore("unignore", [
          { variableId: emptyOld, environmentId: prod.id, reason: "empty" },
          { variableId: onlyStaging, environmentId: prod.id, reason: "missing" },
        ])
      ).toEqual({ success: true, changed: 2 });
      const undone = await view("prod");
      expect(undone.counts).toMatchObject({ empty: 1, missing: 1, ignored: 1 });
    }
  );

  postgresTest(
    // Catches: a forged item writing some ignores before the refused one, or reaching another
    // project's environment or variable, or an environment the role can't write.
    "refuses the whole request when any item is refused",
    async ({ prisma }) => {
      const { prod, set, variableId, ignore, user, project } = await setUp(prisma);
      const other = await setUp(prisma);
      await set(prod.id, "MINE", "");
      await other.set(other.prod.id, "THEIRS", "");
      const mine = await variableId("MINE");
      const theirs = await other.variableId("THEIRS");
      const ok: AttentionIgnoreItem = { variableId: mine, environmentId: prod.id, reason: "empty" };

      const anotherEnvironment = await ignore("ignore", [
        ok,
        { variableId: mine, environmentId: other.prod.id, reason: "empty" },
      ]);
      expect(anotherEnvironment.success).toBe(false);

      const anotherVariable = await ignore("ignore", [
        ok,
        { variableId: theirs, environmentId: prod.id, reason: "empty" },
      ]);
      expect(anotherVariable.success).toBe(false);

      const noWrite = await setAttentionIgnores(prisma, {
        projectId: project.id,
        userId: user.id,
        action: "ignore",
        items: [ok],
        canWrite: (type) => type !== "PRODUCTION",
      });
      expect(noWrite).toEqual({
        success: false,
        error: "You can't change what's ignored in Production.",
      });

      // Another organization's member can't ignore in this project.
      const outsider = await setAttentionIgnores(prisma, {
        projectId: project.id,
        userId: other.user.id,
        action: "ignore",
        items: [ok],
        canWrite: () => true,
      });
      expect(outsider.success).toBe(false);

      expect(await prisma.environmentVariableIgnore.count()).toBe(0);

      // Undo is checked the same way.
      expect((await ignore("ignore", [ok])).success).toBe(true);
      const undoNoWrite = await setAttentionIgnores(prisma, {
        projectId: project.id,
        userId: user.id,
        action: "unignore",
        items: [ok],
        canWrite: () => false,
      });
      expect(undoNoWrite.success).toBe(false);
      expect(await prisma.environmentVariableIgnore.count()).toBe(1);

      // The form takes 1 to 100 items, and never "Changed recently".
      const items = (n: number) => Array.from({ length: n }, () => ok);
      const parse = (list: unknown[]) =>
        AttentionIgnoreForm.safeParse({ action: "ignore-reasons", items: list });
      expect(parse(items(100)).success).toBe(true);
      expect(parse(items(101)).success).toBe(false);
      expect(parse([]).success).toBe(false);
      expect(parse([{ variableId: mine, environmentId: prod.id, reason: "recent" }]).success).toBe(
        false
      );
    }
  );

  postgresTest(
    // Catches: a save path that leaves an ignored Empty in place, so a value emptied again later
    // stays hidden; or a save clearing an ignore of another reason or environment.
    "clears an ignored Empty when the value is saved, in every save path",
    async ({ prisma }) => {
      const { user, project, prod, staging, repository, set, variableId, ignore } =
        await setUp(prisma);
      for (const key of ["BY_CREATE", "BY_EDIT", "BY_EDIT_VALUE", "BY_COPY", "UNTOUCHED"]) {
        await set(prod.id, key, "");
        await set(staging.id, key, key === "BY_COPY" ? "copied" : "");
      }
      await set(staging.id, "MISSING_IN_PROD", "value");
      const ids = Object.fromEntries(
        await Promise.all(
          ["BY_CREATE", "BY_EDIT", "BY_EDIT_VALUE", "BY_COPY", "UNTOUCHED", "MISSING_IN_PROD"].map(
            async (key) => [key, await variableId(key)] as const
          )
        )
      );
      const emptyIn = (environmentId: string) =>
        ["BY_CREATE", "BY_EDIT", "BY_EDIT_VALUE", "BY_COPY", "UNTOUCHED"].map((key) => ({
          variableId: ids[key]!,
          environmentId,
          reason: "empty" as const,
        }));
      await ignore("ignore", [
        ...emptyIn(prod.id),
        ...emptyIn(staging.id),
        { variableId: ids.MISSING_IN_PROD!, environmentId: prod.id, reason: "missing" },
      ]);

      const lastUpdatedBy = { type: "user" as const, userId: user.id };
      expect(
        (
          await repository.create(project.id, {
            override: true,
            environmentIds: [prod.id],
            variables: [{ key: "BY_CREATE", value: "set" }],
            lastUpdatedBy,
          })
        ).success
      ).toBe(true);
      expect(
        (
          await repository.edit(project.id, {
            id: ids.BY_EDIT!,
            values: [{ environmentId: prod.id, value: "set" }],
            lastUpdatedBy,
          })
        ).success
      ).toBe(true);
      expect(
        (
          await repository.editValue(project.id, {
            id: ids.BY_EDIT_VALUE!,
            environmentId: prod.id,
            value: "",
            setEmptyValue: "true",
            lastUpdatedBy,
          })
        ).success
      ).toBe(true);
      expect(
        (
          await repository.copyValues(project.id, {
            sourceEnvironmentId: staging.id,
            targetEnvironmentId: prod.id,
            variableIds: [ids.BY_COPY!],
            lastUpdatedBy,
          })
        ).success
      ).toBe(true);

      const left = await prisma.environmentVariableIgnore.findMany({
        select: { variableId: true, environmentId: true, reason: true },
      });
      const keyOf = new Map(Object.entries(ids).map(([key, id]) => [id, key]));
      const envOf = new Map([
        [prod.id, "prod"],
        [staging.id, "stg"],
      ]);
      expect(
        left
          .map((i) => `${keyOf.get(i.variableId)}:${envOf.get(i.environmentId)}:${i.reason}`)
          .sort()
      ).toEqual([
        "BY_COPY:stg:EMPTY",
        "BY_CREATE:stg:EMPTY",
        "BY_EDIT:stg:EMPTY",
        "BY_EDIT_VALUE:stg:EMPTY",
        "MISSING_IN_PROD:prod:MISSING",
        "UNTOUCHED:prod:EMPTY",
        "UNTOUCHED:stg:EMPTY",
      ]);

      // Deleting a key takes its ignores with it.
      const deleted = await repository.deleteValues(project.id, [
        { id: ids.UNTOUCHED!, environmentId: prod.id },
        { id: ids.UNTOUCHED!, environmentId: staging.id },
      ]);
      expect(deleted.success).toBe(true);
      expect(
        await prisma.environmentVariableIgnore.count({ where: { variableId: ids.UNTOUCHED! } })
      ).toBe(0);
    }
  );
  postgresTest(
    // Catches: a copy of many keys running one ignore delete per key inside its transaction.
    "clears the ignored Empty of every copied key in one statement",
    async ({ prisma }) => {
      const { user, project, prod, staging, set, variableId, ignore } = await setUp(prisma);
      const keys = ["COPY_A", "COPY_B", "COPY_C"];
      for (const key of keys) {
        await set(prod.id, key, "");
        await set(staging.id, key, "value");
      }
      const ids = await Promise.all(keys.map(variableId));
      await ignore(
        "ignore",
        ids.map((id) => ({ variableId: id, environmentId: prod.id, reason: "empty" as const }))
      );

      const ignoreDeletes: string[] = [];
      const counted = prisma.$extends({
        query: {
          environmentVariableIgnore: {
            deleteMany({ args, query }) {
              ignoreDeletes.push("deleteMany");
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const result = await new EnvironmentVariablesRepository(counted, counted).copyValues(
        project.id,
        {
          sourceEnvironmentId: staging.id,
          targetEnvironmentId: prod.id,
          variableIds: ids,
          lastUpdatedBy: { type: "user", userId: user.id },
        }
      );
      expect(result.success).toBe(true);
      expect(ignoreDeletes).toHaveLength(1);
      expect(await prisma.environmentVariableIgnore.count()).toBe(0);
    }
  );
  postgresTest(
    // Catches: a key deleted between the checks and the write failing the request with a 500.
    "refuses an ignore whose key was deleted after it was checked",
    async ({ prisma }) => {
      const { user, project, prod, set, variableId } = await setUp(prisma);
      await set(prod.id, "GOES_AWAY", "");
      const id = await variableId("GOES_AWAY");
      // Deletes the key just before the insert, as a delete committing in between would.
      const racing = prisma.$extends({
        query: {
          environmentVariableIgnore: {
            async createMany({ args, query }) {
              await prisma.environmentVariable.delete({ where: { id } });
              return query(args);
            },
          },
        },
      }) as unknown as PrismaClient;
      const result = await setAttentionIgnores(racing, {
        projectId: project.id,
        userId: user.id,
        action: "ignore",
        items: [{ variableId: id, environmentId: prod.id, reason: "empty" }],
        canWrite: () => true,
      });
      expect(result).toEqual({
        success: false,
        error: "Nothing was changed. A key wasn't found in this project. It may have been deleted.",
      });
    }
  );
});
