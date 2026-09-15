import { describe, expect, vi } from "vitest";

var dbClientHolder: any = undefined;
function setDbClient(client: any) {
  dbClientHolder = client;
}

vi.mock("~/v3/services/baseService.server", async () => {
  const { ServiceValidationError } = await import("~/v3/services/common.server");
  return { ServiceValidationError };
});

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  return {
    Prisma,
    sqlDatabaseSchema: Prisma.sql(["public"]),
    get prisma() {
      return dbClientHolder;
    },
    get $replica() {
      return dbClientHolder;
    },
  };
});

// WaitpointListPresenter reads through the module-global `runStore`; override that one wiring
// boundary with a container-backed store (not a DB mock). Mirrors SpanPresenter.readthrough.test.ts.
const routingStoreRef = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("~/v3/runStore.server", () => ({
  get runStore() {
    return routingStoreRef.current;
  },
}));

import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { ApiWaitpointListPresenter } from "~/presenters/v3/ApiWaitpointListPresenter.server";

vi.setConfig({ testTimeout: 120_000 });

// List reads fan out to both legs and dedup by id, so both legs on one container is fine.
function makeRunStore(newClient: PrismaClient, legacyClient: PrismaClient) {
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

const ENV_ID = "env0000000000000000t19";
const PROJ_ID = "proj00000000000000t19";

async function seedLegacyParents(prisma: PrismaClient, slug: string) {
  const org = await prisma.organization.create({
    data: { title: `org-${slug}`, slug: `org-${slug}` },
  });
  await prisma.project.create({
    data: {
      id: PROJ_ID,
      name: `proj-${slug}`,
      slug: `proj-${slug}`,
      organizationId: org.id,
      externalRef: `proj-${slug}`,
      engine: "V2",
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      id: ENV_ID,
      slug: `env-${slug}`,
      type: "PRODUCTION",
      projectId: PROJ_ID,
      organizationId: org.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: `sc-${slug}`,
    },
  });
}

const baseEnv = {
  id: ENV_ID,
  type: "PRODUCTION" as const,
  project: { id: PROJ_ID, engine: "V2" as const },
  apiKey: "tr_prod_t19",
};

describe("ApiWaitpointListPresenter read-route threading", () => {
  postgresTest(
    "split enabled: waitpoint on NEW handle is returned via the run store",
    async ({ prisma }) => {
      setDbClient(prisma);
      routingStoreRef.current = makeRunStore(prisma, prisma);
      await seedLegacyParents(prisma, "t19split");

      await prisma.waitpoint.create({
        data: {
          id: "wp_t19_0000000000000000001",
          friendlyId: "wpt_t19_001",
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: "idem-t19-001",
          userProvidedIdempotencyKey: false,
          projectId: PROJ_ID,
          environmentId: ENV_ID,
        },
      });

      const presenter = new ApiWaitpointListPresenter(undefined, undefined, {
        runOpsNew: prisma as any,
        runOpsLegacyReplica: prisma as any,
        splitEnabled: true,
      });

      const result = await presenter.call(baseEnv, {});

      expect(result.data.length).toBeGreaterThan(0);
      expect(result.data.some((t) => t.id === "wpt_t19_001")).toBe(true);
    }
  );

  postgresTest(
    "passthrough: no readRoute => run store empty, result empty (nothing seeded)",
    async ({ prisma }) => {
      setDbClient(prisma);
      routingStoreRef.current = makeRunStore(prisma, prisma);
      await seedLegacyParents(prisma, "t19pass");

      const presenter = new ApiWaitpointListPresenter(prisma, prisma);

      const result = await presenter.call(baseEnv, {});
      expect(result.data).toEqual([]);
    }
  );
});
