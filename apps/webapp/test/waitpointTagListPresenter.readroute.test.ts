import { describe, expect, vi } from "vitest";

var dbClientHolder: any = undefined;
function setDbClient(client: any) {
  dbClientHolder = client;
}

vi.mock("~/db.server", () => ({
  get prisma() {
    return dbClientHolder;
  },
  get $replica() {
    return dbClientHolder;
  },
}));

import { heteroRunOpsPostgresTest, postgresTest } from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import {
  WaitpointTagListPresenter,
  type TagListOptions,
} from "~/presenters/v3/WaitpointTagListPresenter.server";

vi.setConfig({ testTimeout: 120_000 });

// Wire the presenter's run store to the test containers so waitpoint-tag reads route to the
// container DBs (NEW=dedicated, LEGACY=legacy) instead of the default localhost:5432 client.
// In single-DB passthrough both legs point at the same client (a no-op fan-out that de-dupes
// back to one DB's rows), mirroring production single-DB deployments.
function makeRunStore(newClient: PrismaClient, legacyClient: PrismaClient): RoutingRunStore {
  return new RoutingRunStore({
    new: new PostgresRunStore({
      prisma: newClient as never,
      readOnlyPrisma: newClient as never,
      schemaVariant: "dedicated",
    }),
    legacy: new PostgresRunStore({
      prisma: legacyClient as never,
      readOnlyPrisma: legacyClient as never,
      schemaVariant: "legacy",
    }),
  });
}

type LegacySeedContext = {
  projectId: string;
  environmentId: string;
};

async function seedLegacyParents(prisma: PrismaClient, slug: string): Promise<LegacySeedContext> {
  const organization = await prisma.organization.create({
    data: { title: `org-${slug}`, slug: `org-${slug}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: organization.id,
      externalRef: `proj-${slug}`,
      engine: "V2",
    },
  });
  const env = await prisma.runtimeEnvironment.create({
    data: {
      slug: `env-${slug}`,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });
  return { projectId: project.id, environmentId: env.id };
}

async function seedLegacyParentsWithIds(
  prisma: PrismaClient,
  slug: string,
  environmentId: string,
  projectId: string
): Promise<void> {
  const organization = await prisma.organization.create({
    data: { title: `org-${slug}`, slug: `org-${slug}` },
  });
  await prisma.project.create({
    data: {
      id: projectId,
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: organization.id,
      externalRef: `proj-${slug}`,
      engine: "V2",
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      id: environmentId,
      slug: `env-${slug}`,
      type: "PRODUCTION",
      projectId,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });
}

function opts(environmentId: string, overrides: Partial<TagListOptions> = {}): TagListOptions {
  return { environmentId, ...overrides };
}

describe("WaitpointTagListPresenter read-route", () => {
  postgresTest(
    "passthrough: single-DB read returns the env's tags ordered id desc",
    async ({ prisma }) => {
      setDbClient(prisma);
      const ctx = await seedLegacyParents(prisma, "pass");

      await prisma.waitpointTag.createMany({
        data: [
          {
            id: "ct000000000000000000001",
            name: "alpha",
            environmentId: ctx.environmentId,
            projectId: ctx.projectId,
          },
          {
            id: "ct000000000000000000002",
            name: "beta",
            environmentId: ctx.environmentId,
            projectId: ctx.projectId,
          },
          {
            id: "ct000000000000000000003",
            name: "gamma",
            environmentId: ctx.environmentId,
            projectId: ctx.projectId,
          },
        ],
      });

      // Single-DB deployment: both run-store legs point at the same container client, so the
      // mandatory NEW+LEGACY fan-out in findManyWaitpointTags reads one DB and de-dupes by id.
      const presenter = new WaitpointTagListPresenter(
        prisma,
        prisma,
        undefined,
        makeRunStore(prisma, prisma)
      );
      const result = await presenter.call(opts(ctx.environmentId, { pageSize: 10 }));

      expect(result.tags.map((t) => t.name)).toEqual(["gamma", "beta", "alpha"]);
      expect(result.hasMore).toBe(false);
      expect(result.currentPage).toBe(1);
    }
  );

  heteroRunOpsPostgresTest(
    "split merge: tags from NEW and LEGACY are deduped and ordered id desc",
    async ({ prisma14, prisma17 }) => {
      setDbClient(prisma14);

      const envId = "env0000000000000000001";
      const projId = "proj000000000000000001";

      await seedLegacyParentsWithIds(prisma14, "merge14", envId, projId);

      await (prisma17 as RunOpsPrismaClient).waitpointTag.createMany({
        data: [
          { id: "mt000000000000000000005", name: "echo", environmentId: envId, projectId: projId },
          { id: "mt000000000000000000004", name: "delta", environmentId: envId, projectId: projId },
        ],
      });

      await (prisma14 as PrismaClient).waitpointTag.createMany({
        data: [
          {
            id: "mt000000000000000000004",
            name: "delta-stale",
            environmentId: envId,
            projectId: projId,
          },
          {
            id: "mt000000000000000000003",
            name: "charlie",
            environmentId: envId,
            projectId: projId,
          },
          { id: "mt000000000000000000002", name: "bravo", environmentId: envId, projectId: projId },
          { id: "mt000000000000000000001", name: "alpha", environmentId: envId, projectId: projId },
        ],
      });

      const presenter = new WaitpointTagListPresenter(
        prisma14 as any,
        prisma14 as any,
        undefined,
        makeRunStore(prisma17 as any, prisma14 as any)
      );

      const result = await presenter.call(opts(envId, { pageSize: 4 }));

      expect(result.tags.map((t) => t.name)).toEqual(["echo", "delta", "charlie", "bravo"]);
      expect(result.hasMore).toBe(true);

      const dupes = result.tags.filter((t) => t.name === "delta-stale");
      expect(dupes).toHaveLength(0);
      expect(result.tags.filter((t) => t.name === "delta")).toHaveLength(1);
    }
  );

  heteroRunOpsPostgresTest(
    "offset window: page 2 returns the correct slice of the merged prefix",
    async ({ prisma14, prisma17 }) => {
      setDbClient(prisma14);

      const envId = "env0000000000000000002";
      const projId = "proj000000000000000002";

      await seedLegacyParentsWithIds(prisma14, "page214", envId, projId);

      await (prisma17 as RunOpsPrismaClient).waitpointTag.createMany({
        data: [
          { id: "pt000000000000000000006", name: "f", environmentId: envId, projectId: projId },
          { id: "pt000000000000000000005", name: "e", environmentId: envId, projectId: projId },
        ],
      });
      await (prisma14 as PrismaClient).waitpointTag.createMany({
        data: [
          { id: "pt000000000000000000004", name: "d", environmentId: envId, projectId: projId },
          { id: "pt000000000000000000003", name: "c", environmentId: envId, projectId: projId },
          { id: "pt000000000000000000002", name: "b", environmentId: envId, projectId: projId },
          { id: "pt000000000000000000001", name: "a", environmentId: envId, projectId: projId },
        ],
      });

      const presenter = new WaitpointTagListPresenter(
        prisma14 as any,
        prisma14 as any,
        undefined,
        makeRunStore(prisma17 as any, prisma14 as any)
      );

      const page2 = await presenter.call(opts(envId, { pageSize: 2, page: 2 }));
      expect(page2.tags.map((t) => t.name)).toEqual(["d", "c"]);
      expect(page2.hasMore).toBe(true);
      expect(page2.currentPage).toBe(2);

      const page3 = await presenter.call(opts(envId, { pageSize: 2, page: 3 }));
      expect(page3.tags.map((t) => t.name)).toEqual(["b", "a"]);
      expect(page3.hasMore).toBe(false);
    }
  );
});
