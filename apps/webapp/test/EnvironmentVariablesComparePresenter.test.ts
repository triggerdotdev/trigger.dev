import { describe, expect, test, vi } from "vitest";

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
import { EnvironmentVariablesComparePresenter } from "~/presenters/v3/EnvironmentVariablesComparePresenter.server";
import {
  canTickCompareRows,
  compareCopyPlan,
  compareSelectedLink,
  parseCompareSelectedKeys,
} from "~/v3/environmentVariables/compare";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  createEnvironmentVariable,
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  enrollProxyOnlyValue,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

async function createProject(prisma: PrismaClient) {
  const { user, organization, project, orgMember } = await createTestOrgProjectWithMember(prisma);
  await prisma.organization.update({
    where: { id: organization.id },
    data: { featureFlags: { allowEmptyEnvironmentVariableValues: true } },
  });
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

  const compare = (
    options: Partial<Parameters<EnvironmentVariablesComparePresenter["call"]>[0]> = {}
  ) =>
    new EnvironmentVariablesComparePresenter(prisma, prisma).call({
      userId: user.id,
      projectId: project.id,
      left: "stg",
      right: "prod",
      canRead: () => true,
      maxKeys: 1000,
      ...options,
    });

  const allowEmptyValues = (allowed: boolean) =>
    prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: { allowEmptyEnvironmentVariableValues: allowed } },
    });

  return {
    production,
    staging,
    preview,
    development,
    createBranch,
    set,
    compare,
    allowEmptyValues,
  };
}

describe("EnvironmentVariablesComparePresenter", () => {
  postgresTest(
    "puts every key under one kind and compares secrets without returning them",
    async ({ prisma }) => {
      const { production, staging, set, compare } = await createProject(prisma);

      await set(staging.id, "SAME", "same");
      await set(production.id, "SAME", "same");
      await set(staging.id, "DIFFERENT", "stg-plain");
      await set(production.id, "DIFFERENT", "prod-plain");
      await set(staging.id, "ONLY_STAGING", "only-stg");
      await set(production.id, "ONLY_PROD", "only-prod");
      await set(staging.id, "EMPTY_IN_PROD", "has-a-value");
      await set(production.id, "EMPTY_IN_PROD", "");
      await set(staging.id, "SECRET_DIFFERENT", "stg-secret-value", true);
      await set(production.id, "SECRET_DIFFERENT", "prod-secret-value", true);
      await set(staging.id, "SECRET_SAME", "shared-secret-value", true);
      await set(production.id, "SECRET_SAME", "shared-secret-value", true);
      await set(staging.id, "SECRET_EMPTY_IN_PROD", "stg-other-secret", true);
      await set(production.id, "SECRET_EMPTY_IN_PROD", "", true);
      await set(staging.id, "SECRET_EMPTY_BOTH", "", true);
      await set(production.id, "SECRET_EMPTY_BOTH", "", true);

      const differences = await compare();
      const same = await compare({ kind: "same" });
      const allRows = [...differences!.rows, ...same!.rows];
      const kinds = Object.fromEntries(allRows.map((row) => [row.key, row.kind]));

      // Catches: a key counted under two kinds or none, so the counts stop adding up to the keys.
      expect(kinds).toEqual({
        SAME: "same",
        DIFFERENT: "different",
        ONLY_STAGING: "left",
        ONLY_PROD: "right",
        EMPTY_IN_PROD: "empty",
        SECRET_DIFFERENT: "different",
        SECRET_SAME: "same",
        // Catches: an empty secret hidden under Different instead of flagged as Empty.
        SECRET_EMPTY_IN_PROD: "empty",
        SECRET_EMPTY_BOTH: "same",
      });
      expect(differences!.counts).toEqual({
        different: 2,
        left: 1,
        right: 1,
        empty: 2,
        same: 3,
        uncompared: 0,
        unset: 0,
      });

      // Catches: a secret's value (or anything but "differs") sent to the page.
      const secretRow = allRows.find((row) => row.key === "SECRET_DIFFERENT");
      expect(secretRow!.left).toEqual({ isSet: true, value: "", isSecret: true, differs: true });
      expect(secretRow!.right).toEqual({ isSet: true, value: "", isSecret: true, differs: true });
      expect(JSON.stringify([differences, same])).not.toMatch(/secret-value|stg-other-secret/);
      // Catches: the non-empty secret beside an empty one marked as differing, or the empty one
      // not marked Empty.
      const emptySecretRow = allRows.find((row) => row.key === "SECRET_EMPTY_IN_PROD");
      expect(emptySecretRow!.left).toEqual({ isSet: true, value: "", isSecret: true });
      expect(emptySecretRow!.right).toEqual({
        isSet: true,
        value: "",
        isSecret: true,
        emptySecret: true,
      });

      // Values that aren't secret are sent as the list sends them.
      expect(allRows.find((row) => row.key === "DIFFERENT")).toMatchObject({
        left: { value: "stg-plain" },
        right: { value: "prod-plain" },
      });
      expect(allRows.find((row) => row.key === "ONLY_STAGING")!.right).toEqual({ isSet: false });

      // Catches: same keys listed under All, Same listing anything else, or a kind filter that
      // lets other kinds through. All and Same together are every key.
      expect(differences!.rows.map((row) => row.key)).not.toContain("SAME");
      expect(differences!.pagination.totalCount).toBe(6);
      expect(same!.rows.map((row) => row.key)).toEqual([
        "SAME",
        "SECRET_EMPTY_BOTH",
        "SECRET_SAME",
      ]);
      const onlyLeft = await compare({ kind: "left" });
      expect(onlyLeft!.rows.map((row) => row.key)).toEqual(["ONLY_STAGING"]);
      // The counts describe the whole comparison, whatever is listed.
      expect(onlyLeft!.counts).toEqual(differences!.counts);

      // Catches: paging before filtering, which leaves pages short or repeats keys.
      const secondPage = await compare({ pageSize: 4, page: 2 });
      expect(secondPage!.rows.map((row) => row.key)).toEqual(
        differences!.rows.slice(4, 6).map((r) => r.key)
      );
      expect(secondPage!.pagination).toEqual({ currentPage: 2, totalPages: 2, totalCount: 6 });

      const searched = await compare({ search: "secret" });
      expect(searched!.rows.map((row) => row.key)).toEqual([
        "SECRET_DIFFERENT",
        "SECRET_EMPTY_IN_PROD",
      ]);

      // Swapped, "missing in" follows its side.
      const swapped = await compare({ left: "prod", right: "stg" });
      expect(swapped!.counts).toMatchObject({ left: 1, right: 1, different: 2, empty: 2 });
      expect(swapped!.rows.find((row) => row.key === "ONLY_PROD")!.kind).toBe("left");
    }
  );

  postgresTest(
    "never says whether a secret equals a plain value, which would reveal the secret",
    async ({ prisma }) => {
      const { production, staging, set, compare } = await createProject(prisma);

      await set(staging.id, "MIXED_EQUAL", "mixed-shared-value");
      await set(production.id, "MIXED_EQUAL", "mixed-shared-value", true);
      await set(staging.id, "MIXED_DIFFERENT", "mixed-plain-value");
      await set(production.id, "MIXED_DIFFERENT", "mixed-other-value", true);
      await set(staging.id, "MIXED_PLAIN_EMPTY", "");
      await set(production.id, "MIXED_PLAIN_EMPTY", "mixed-secret-value", true);
      await set(staging.id, "MIXED_SECRET_EMPTY", "mixed-plain-only", true);
      await set(production.id, "MIXED_SECRET_EMPTY", "", true);
      await set(staging.id, "MIXED_BOTH_EMPTY", "");
      await set(production.id, "MIXED_BOTH_EMPTY", "", true);
      await set(staging.id, "PLAIN_SAME", "same");
      await set(production.id, "PLAIN_SAME", "same");

      const all = await compare();
      const same = await compare({ kind: "same" });
      const kinds = Object.fromEntries(
        [...all!.rows, ...same!.rows].map((row) => [row.key, row.kind])
      );
      // Catches: an equal plain value and secret listed as Same, with the plain value on the page.
      expect(kinds).toEqual({
        MIXED_EQUAL: "uncompared",
        MIXED_DIFFERENT: "uncompared",
        MIXED_BOTH_EMPTY: "uncompared",
        // Emptiness is on the cells already (the plain value, the secret's Empty flag).
        MIXED_PLAIN_EMPTY: "empty",
        MIXED_SECRET_EMPTY: "empty",
        PLAIN_SAME: "same",
      });
      // Catches: a mixed key counted under a kind, so the counts stop adding up to the keys.
      expect(all!.counts).toEqual({
        different: 0,
        left: 0,
        right: 0,
        empty: 2,
        same: 1,
        uncompared: 3,
        unset: 0,
      });
      expect(all!.mixedSecretCount).toBe(3);
      const mixed = all!.rows.find((row) => row.key === "MIXED_DIFFERENT")!;
      // Catches: "differs" on a secret compared with a plain value.
      expect(mixed.right).toEqual({ isSet: true, value: "", isSecret: true });
      expect(JSON.stringify([all, same])).not.toMatch(/mixed-secret-value|mixed-other-value/);

      // Catches: the copy plan skipping an equal mixed pair as "already matches".
      const equal = all!.rows.find((row) => row.key === "MIXED_EQUAL")!;
      const plan = compareCopyPlan([equal], "left", all!.emptyValuesAllowed);
      expect(plan.copied).toEqual([{ row: equal, replaces: true }]);
      expect(plan.skipped).toEqual({ notSet: 0, unreadable: 0, matching: 0, empty: 0 });
    }
  );

  postgresTest(
    "skips empty sources in the copy plan when the organization doesn't allow empty values",
    async ({ prisma }) => {
      const { production, staging, set, compare, allowEmptyValues } = await createProject(prisma);

      await set(staging.id, "PLAIN_EMPTY", "");
      await set(staging.id, "PLAIN_WHITESPACE", "   ");
      await set(staging.id, "SECRET_EMPTY", "", true);
      await set(production.id, "SECRET_EMPTY", "prod-secret", true);
      await set(staging.id, "HAS_VALUE", "stg-value");

      const allowed = await compare();
      expect(allowed!.emptyValuesAllowed).toBe(true);
      expect(compareCopyPlan(allowed!.rows, "left", true).copied).toHaveLength(4);

      await allowEmptyValues(false);
      const comparison = await compare();
      expect(comparison!.emptyValuesAllowed).toBe(false);
      // Catches: the dialog offering empty values that the copy then refuses at confirm.
      const plan = compareCopyPlan(comparison!.rows, "left", comparison!.emptyValuesAllowed);
      expect(plan.copied.map(({ row }) => row.key)).toEqual(["HAS_VALUE"]);
      expect(plan.skipped).toEqual({ notSet: 0, unreadable: 0, matching: 0, empty: 3 });
    }
  );

  postgresTest(
    "skips a proxy-only source in the copy plan, still shown as a secret",
    async ({ prisma }) => {
      const { staging, set, compare } = await createProject(prisma);

      await set(staging.id, "PROXY_TOKEN", "proxy-secret-value", true);
      await set(staging.id, "HAS_VALUE", "stg-value");
      const before = await compare();
      await enrollProxyOnlyValue(prisma, {
        environmentId: staging.id,
        variableId: before!.rows.find((row) => row.key === "PROXY_TOKEN")!.id,
        allowedHosts: ["api.example.com"],
      });

      const comparison = await compare();
      const proxy = comparison!.rows.find((row) => row.key === "PROXY_TOKEN")!;
      expect(proxy.left).toEqual({ isSet: true, value: "", isSecret: true, unreadable: true });
      // Catches: a proxy-only source offered in the dialog, which makes the copy refuse every value.
      const plan = compareCopyPlan(comparison!.rows, "left", comparison!.emptyValuesAllowed);
      expect(plan.copied.map(({ row }) => row.key)).toEqual(["HAS_VALUE"]);
      expect(plan.skipped).toEqual({ notSet: 0, unreadable: 1, matching: 0, empty: 0 });
    }
  );

  postgresTest(
    "compares no more keys than the limit, and reads no values above it",
    async ({ prisma }) => {
      const { production, staging, set, compare } = await createProject(prisma);
      await set(staging.id, "ALPHA_ONE", "a1");
      await set(production.id, "ALPHA_ONE", "a1-prod");
      await set(staging.id, "ALPHA_TWO", "a2", true);
      await set(production.id, "BETA_ONE", "b1");

      // Catches: a comparison over the limit still reading and decrypting every value.
      const read = vi.spyOn(EnvironmentVariablesRepository.prototype, "getVariableValuesForKeys");
      const over = await compare({ maxKeys: 2 });
      expect(read).not.toHaveBeenCalled();
      read.mockRestore();
      expect(over!.tooManyKeys).toEqual({ count: 3, max: 2 });
      expect(over!.rows).toEqual([]);
      expect(Object.values(over!.counts).every((count) => count === 0)).toBe(true);

      const atLimit = await compare({ maxKeys: 3 });
      expect(atLimit!.tooManyKeys).toBeUndefined();
      expect(atLimit!.rows.map((row) => row.key)).toEqual(["ALPHA_ONE", "ALPHA_TWO", "BETA_ONE"]);

      const searched = await compare({ maxKeys: 2, search: "alpha" });
      expect(searched!.tooManyKeys).toBeUndefined();
      expect(searched!.rows.map((row) => row.key)).toEqual(["ALPHA_ONE", "ALPHA_TWO"]);

      const ticked = await compare({ maxKeys: 2, selectedKeys: ["ALPHA_ONE", "BETA_ONE"] });
      expect(ticked!.tooManyKeys).toBeUndefined();
      expect(ticked!.rows.map((row) => row.key)).toEqual(["ALPHA_ONE", "BETA_ONE"]);
    }
  );

  postgresTest(
    "reads nothing from a side the role can't read, and compares nothing against it",
    async ({ prisma }) => {
      const { production, staging, set, compare } = await createProject(prisma);

      await set(staging.id, "BOTH", "stg-visible");
      await set(production.id, "BOTH", "prod-hidden-value");
      await set(staging.id, "BOTH_SAME", "equal-on-both");
      await set(production.id, "BOTH_SAME", "equal-on-both");
      await set(staging.id, "ONLY_STAGING", "only-stg");
      await set(production.id, "ONLY_PROD", "prod-hidden-only", true);

      const comparison = await compare({
        canRead: (type) => type !== "PRODUCTION",
      });

      expect(comparison!.right.isReadable).toBe(false);
      // Catches: a same-or-different answer about values the role can't read. Which keys are
      // set there is already on the list, so "only in" still counts.
      expect(comparison!.counts).toEqual({
        different: 0,
        left: 1,
        right: 1,
        empty: 0,
        same: 0,
        uncompared: 2,
        unset: 0,
      });
      const denied = { isSet: true, value: "", isSecret: false, permissionDenied: true };
      expect(comparison!.rows.find((row) => row.key === "BOTH")).toMatchObject({
        kind: "uncompared",
        left: { value: "stg-visible" },
        right: denied,
      });
      expect(comparison!.rows.find((row) => row.key === "ONLY_PROD")!.right).toEqual(denied);
      // Catches: the unreadable side's values serialized to the page.
      expect(JSON.stringify(comparison)).not.toMatch(/prod-hidden/);
    }
  );

  postgresTest(
    "compares a branch by its own values, and falls back from unknown or equal sides",
    async ({ prisma }) => {
      const { production, staging, preview, createBranch, set, compare } =
        await createProject(prisma);
      const branch = await createBranch("feat/checkout");

      await set(preview.id, "INHERITED", "preview-base");
      await set(preview.id, "OVERRIDDEN", "preview-base");
      await set(branch.id, "OVERRIDDEN", "branch-value");
      await set(branch.id, "BRANCH_ONLY", "branch-value");
      await set(staging.id, "STAGING_KEY", "stg");
      await set(production.id, "PROD_KEY", "prod");

      // Catches: a branch against its Preview base listing the keys it only inherits, which
      // buries its overrides.
      const overrides = await compare({
        left: "branch:feat/checkout",
        right: "preview",
      });
      expect(overrides!.left.environment.id).toBe(branch.id);
      expect(overrides!.rows.map((row) => [row.key, row.kind])).toEqual([
        ["BRANCH_ONLY", "left"],
        ["OVERRIDDEN", "different"],
      ]);
      expect(overrides!.inheritedCount).toBe(1);
      const swapped = await compare({ left: "preview", right: "branch:feat/checkout" });
      expect(swapped!.rows.map((row) => [row.key, row.kind])).toEqual([
        ["BRANCH_ONLY", "right"],
        ["OVERRIDDEN", "different"],
      ]);

      // Catches: a branch side filled in with the values it inherits. Against anything but its
      // base, a branch is its own values and nothing is left out.
      const againstProd = await compare({ left: "branch:feat/checkout", right: "prod" });
      expect(againstProd!.inheritedCount).toBe(0);
      expect(againstProd!.rows.map((row) => [row.key, row.kind])).toEqual([
        ["BRANCH_ONLY", "left"],
        ["OVERRIDDEN", "left"],
        ["PROD_KEY", "right"],
      ]);

      // Catches: an unknown side failing the page, or a side compared with itself.
      const sides = async (options: Parameters<typeof compare>[0]) => {
        const comparison = await compare(options);
        return [comparison!.left.value, comparison!.right.value];
      };
      expect(
        await sides({ left: "nonsense", right: "prod", currentEnvironmentSlug: staging.slug })
      ).toEqual(["stg", "prod"]);
      expect(await sides({ left: "prod", right: "prod" })).toEqual(["prod", "stg"]);
      expect(await sides({ left: "stg", right: "branch:gone" })).toEqual(["stg", "prod"]);
      expect(
        await sides({ left: "all", right: undefined, currentEnvironmentSlug: production.slug })
      ).toEqual(["prod", "stg"]);
    }
  );

  postgresTest(
    "reads the keys set on both sides and this page's values, nothing more",
    async ({ prisma }) => {
      const { production, staging, set, compare } = await createProject(prisma);

      await set(staging.id, "A_ONLY_STAGING", "only-a");
      await set(staging.id, "B_ONLY_STAGING", "only-b");
      await set(staging.id, "C_EMPTY_SECRET_ONLY_STAGING", "", true);
      await set(staging.id, "D_BOTH", "stg-d");
      await set(production.id, "D_BOTH", "prod-d");

      const read = vi.spyOn(EnvironmentVariablesRepository.prototype, "getVariableValuesForKeys");
      const firstPage = await compare({ kind: "left", pageSize: 1 });
      const readKeys = read.mock.calls.flatMap(([, items]) => items.map((item) => item.key));
      read.mockRestore();

      // Catches: every value of both sides read and decrypted for one page.
      expect(readKeys.sort()).toEqual(["A_ONLY_STAGING", "D_BOTH", "D_BOTH"]);
      // The counts still cover every key, and the page's value is shown.
      expect(firstPage!.counts).toMatchObject({ left: 3, different: 1 });
      expect(firstPage!.rows).toEqual([
        {
          id: expect.any(String),
          key: "A_ONLY_STAGING",
          kind: "left",
          left: { isSet: true, value: "only-a", isSecret: false },
          right: { isSet: false },
        },
      ]);
      // Catches: a one-sided empty secret on a later page losing its Empty flag.
      const lastPage = await compare({ kind: "left", pageSize: 1, page: 3 });
      expect(lastPage!.rows[0]!.left).toEqual({
        isSet: true,
        value: "",
        isSecret: true,
        emptySecret: true,
      });
    }
  );

  postgresTest("compares only the selected keys", async ({ prisma }) => {
    const { production, staging, development, set, compare } = await createProject(prisma);

    await set(staging.id, "PICKED_DIFFERENT", "a");
    await set(production.id, "PICKED_DIFFERENT", "b");
    await set(staging.id, "PICKED_SAME", "same");
    await set(production.id, "PICKED_SAME", "same");
    await set(production.id, "PICKED_ONLY_PROD", "p");
    await set(development.id, "PICKED_ONLY_DEV", "d");
    await set(staging.id, "NOT_PICKED", "x");
    await set(production.id, "NOT_PICKED", "y");

    const selectedKeys = [
      "PICKED_DIFFERENT",
      "PICKED_SAME",
      "PICKED_ONLY_PROD",
      "PICKED_ONLY_DEV",
      "NOT_IN_PROJECT",
    ];
    const subset = await compare({ selectedKeys });

    // Catches: the subset ignored, a key the project doesn't have listed, or a selected key set
    // on neither side dropped so the user can't see it was asked for.
    expect(subset!.rows.map((row) => [row.key, row.kind])).toEqual([
      ["PICKED_DIFFERENT", "different"],
      ["PICKED_ONLY_DEV", "unset"],
      ["PICKED_ONLY_PROD", "right"],
    ]);
    expect((await compare({ selectedKeys, kind: "same" }))!.rows.map((row) => row.key)).toEqual([
      "PICKED_SAME",
    ]);
    expect(subset!.counts).toEqual({
      different: 1,
      left: 0,
      right: 1,
      empty: 0,
      same: 1,
      uncompared: 0,
      unset: 1,
    });
    expect(subset!.selectedKeyCount).toBe(4);
    // A kind tab leaves out the unset row; the search works inside the subset.
    expect((await compare({ selectedKeys, kind: "right" }))!.rows.map((row) => row.key)).toEqual([
      "PICKED_ONLY_PROD",
    ]);
    expect((await compare({ selectedKeys, search: "only" }))!.rows.map((row) => row.key)).toEqual([
      "PICKED_ONLY_DEV",
      "PICKED_ONLY_PROD",
    ]);
    // Without a subset, every key and no count of selected keys.
    const all = await compare();
    expect(all!.rows.map((row) => row.key)).toContain("NOT_PICKED");
    expect(all!.selectedKeyCount).toBeUndefined();
  });

  // Catches: a malformed key reaching the query, or more keys than the list can select.
  test("selected keys from the URL are well-formed, distinct and at most 100", () => {
    expect(parseCompareSelectedKeys([])).toBeUndefined();
    expect(parseCompareSelectedKeys(["", "a b", "x'--"])).toBeUndefined();
    expect(parseCompareSelectedKeys(["A", "A", "B_1"])).toEqual(["A", "B_1"]);
    const many = Array.from({ length: 150 }, (_, i) => `KEY_${i}`);
    expect(parseCompareSelectedKeys(many)).toEqual(many.slice(0, 100));
  });

  test("gives the rows checkboxes only where ticking can lead to a copy", () => {
    const access = (isReadable: boolean, isWritable: boolean) => ({ isReadable, isWritable });
    const both = { left: access(true, true), right: access(true, true) };
    expect(canTickCompareRows(both, undefined)).toBe(true);
    expect(canTickCompareRows(both, "different")).toBe(true);
    // Catches: checkboxes on the Same tab, where every key already matches.
    expect(canTickCompareRows(both, "same")).toBe(false);
    // Catches: checkboxes for a role that can read both sides but write neither.
    expect(
      canTickCompareRows({ left: access(true, false), right: access(true, false) }, undefined)
    ).toBe(false);
    // One way is enough: read Staging, write Prod.
    expect(
      canTickCompareRows({ left: access(true, false), right: access(false, true) }, undefined)
    ).toBe(true);
  });

  test("disables the list's Compare when the ticked keys make the URL too long", () => {
    const keys = (length: number) =>
      Array.from({ length: 100 }, (_, i) => `key=K${i}_${"A".repeat(length)}`).join("&");
    expect(compareSelectedLink(`/compare?${keys(20)}`)).toEqual({ to: `/compare?${keys(20)}` });
    // Catches: a link Node answers with a bare 431 (measured at about 16,000 characters).
    expect(compareSelectedLink(`/compare?${keys(170)}`)).toMatchObject({ disabled: true });
  });
});
