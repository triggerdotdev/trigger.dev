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
import { viewAfterCreate } from "~/v3/environmentVariables/viewAfterCreate.server";
import {
  createEnvironmentVariable,
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

describe("viewAfterCreate", () => {
  // Catches: the landing page assuming a saved key sorts last (oldest first) or first (newest
  // first), and an archived branch's URL counting every environment instead of Preview.
  postgresTest("opens the page the list shows the key on", async ({ prisma }) => {
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
    const archived = await branch("preview-old", "feature/old");
    await prisma.runtimeEnvironment.update({
      where: { id: archived.id },
      data: { archivedAt: new Date() },
    });

    const repository = new EnvironmentVariablesRepository(prisma, prisma);
    const set = async (environmentId: string, key: string, time?: string) => {
      await createEnvironmentVariable(repository, project.id, {
        environmentId,
        key,
        value: key.toLowerCase(),
        userId: user.id,
      });
      if (time) await setUpdatedAt(prisma, project.id, key, environmentId, time);
    };
    for (const key of ["AA_1", "AA_2", "AA_3"]) await set(prod.id, key);
    for (let day = 1; day <= 5; day++)
      await set(preview.id, `K${day}`, `2026-01-0${day}T00:00:00Z`);
    // The oldest base key gets a branch override now: oldest first still places it by its base value.
    await set(branchA.id, "K1");

    const pageSize = 2;
    const land = (slug: string, search: string, savedEnvironmentIds: string[], key: string) =>
      viewAfterCreate(prisma, {
        url: `http://localhost/new?${search}`,
        userId: user.id,
        projectId: project.id,
        currentEnvironmentSlug: slug,
        savedEnvironmentIds,
        key,
        pageSize,
      });
    const listed = async (slug: string, search: string, key: string) => {
      const params = new URLSearchParams(search);
      const result = await new EnvironmentVariablesPresenter(prisma, prisma).call({
        userId: user.id,
        projectId: project.id,
        currentEnvironmentSlug: slug,
        environmentFilter: (params.get("env") ?? undefined) as "preview" | undefined,
        branches: params.getAll("branch"),
        sort: (params.get("sort") ?? undefined) as "updated" | "updated-asc" | undefined,
        page: Number(params.get("page") ?? 1),
        pageSize,
      });
      return result.environmentVariables.some((variable) => variable.key === key);
    };

    const branchView = "env=preview&branch=feature%2Fa";
    const oldest = await land("prod", `${branchView}&sort=updated-asc`, [branchA.id], "K1");
    expect(oldest.url.searchParams.get("page")).toBeNull();
    expect(await listed("prod", oldest.url.search, "K1")).toBe(true);

    // Newest first: K1 (now), K5, K4, K3 come before K2.
    const newest = await land("prod", `${branchView}&sort=updated`, [branchA.id], "K2");
    expect(newest.url.searchParams.get("page")).toBe("3");
    expect(await listed("prod", newest.url.search, "K2")).toBe(true);

    // An archived branch's URL lists Preview only: the Prod keys before K3 don't count.
    const fromArchived = await land("preview-old", "", [preview.id], "K3");
    expect(fromArchived.switched).toBe(false);
    expect(fromArchived.url.searchParams.get("page")).toBe("2");
    expect(await listed("preview-old", fromArchived.url.search, "K3")).toBe(true);
  });
});

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
