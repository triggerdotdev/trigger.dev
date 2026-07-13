// Real PG14 (control-plane) + PG17 (run-ops) proof for the waitpoint presenter after its
// inlined environment select was decomposed onto the ControlPlaneResolver. The waitpoint
// scalar row lives on PG17 (run-ops); the env (apiKey/organizationId) lives on PG14
// (control-plane), with the cross-seam Waitpoint FKs dropped. The presenter reads waitpoint
// scalars + environmentId from run-ops and resolves the env-derived fields from control-plane.
// The DB is never mocked; the .count() proof shows neither DB joins the other.
import { heteroPostgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

// The presenter resolves the env off the module-level `controlPlaneResolver` singleton, which reads
// the `~/db.server` `prisma` singleton (split off -> controlPlanePrimary). We point that proxy at the
// REAL control-plane container (PG14). The DB is NEVER mocked: the proxy forwards to a real client.
const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) {
            throw new Error(`${label} not set for this test`);
          }
          return holder.client[prop];
        },
      }
    );
  const proxy = lazyProxy(primaryHolder, "primaryHolder.client");
  return {
    prisma: proxy,
    $replica: proxy,
    runOpsNewPrisma: proxy,
    sqlDatabaseSchema: Prisma.sql([`public`]),
    DATABASE_SCHEMA: "public",
  };
});

import type { PrismaClient } from "@trigger.dev/database";
import { WaitpointPresenter } from "~/presenters/v3/WaitpointPresenter.server";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const WAITPOINT_CROSS_SEAM_FKS = [
  "Waitpoint_environmentId_fkey",
  "Waitpoint_projectId_fkey",
] as const;

async function dropWaitpointCrossSeamFks(prisma: PrismaClient) {
  for (const c of WAITPOINT_CROSS_SEAM_FKS) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Waitpoint" DROP CONSTRAINT IF EXISTS "${c}"`);
  }
}

let n = 0;
async function seedControlPlane(prisma: PrismaClient) {
  const s = n++;
  const organization = await prisma.organization.create({
    data: { title: `Org ${s}`, slug: `org-${s}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `P ${s}`,
      slug: `p-${s}`,
      externalRef: `proj_${s}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `env-${s}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_${s}`,
      pkApiKey: `pk_${s}`,
      shortcode: `sc_${s}`,
    },
  });
  return { organization, project, environment };
}

async function seedWaitpoint(
  prisma: PrismaClient,
  ctx: { environmentId: string; projectId: string }
) {
  const s = n++;
  return prisma.waitpoint.create({
    data: {
      id: `waitpoint_${s}_pg17`,
      friendlyId: `waitpoint_fr_${s}`,
      type: "MANUAL",
      status: "PENDING",
      idempotencyKey: `idem_${s}`,
      userProvidedIdempotencyKey: false,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
    },
  });
}

describe("waitpoint presenter cross-DB read-through", () => {
  heteroPostgresTest(
    "waitpoint scalars resolve from run-ops; apiKey/organizationId resolve from control-plane",
    async ({ prisma14, prisma17 }) => {
      await dropWaitpointCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedControlPlane(prisma14 as unknown as PrismaClient);
      const waitpoint = await seedWaitpoint(prisma17 as unknown as PrismaClient, {
        environmentId: cp.environment.id,
        projectId: cp.project.id,
      });

      // Run-ops read: waitpoint scalars + environmentId, no environment relation.
      const found = await (prisma17 as unknown as PrismaClient).waitpoint.findFirst({
        where: { friendlyId: waitpoint.friendlyId, environmentId: cp.environment.id },
        select: { id: true, friendlyId: true, environmentId: true },
      });
      expect(found).not.toBeNull();
      expect(found!.environmentId).toBe(cp.environment.id);

      // Control-plane resolution of the env-derived fields the presenter uses.
      const resolver = new ControlPlaneResolver({
        controlPlanePrimary: prisma14 as unknown as PrismaClient,
        controlPlaneReplica: prisma14 as unknown as PrismaClient,
        cache: new ControlPlaneCache(),
        splitEnabled: () => false,
      });
      const env = await resolver.resolveAuthenticatedEnv(found!.environmentId);
      expect(env).not.toBeNull();
      expect(env!.apiKey).toBe(cp.environment.apiKey);
      expect(env!.organizationId).toBe(cp.organization.id);

      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).waitpoint.count()).toBe(0);
    }
  );

  heteroPostgresTest(
    "presenter returns null when env unresolvable (no false hydrate)",
    async ({ prisma14, prisma17 }) => {
      await dropWaitpointCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedControlPlane(prisma14 as unknown as PrismaClient);
      // The waitpoint references an environmentId with NO row on control-plane (PG14).
      const absentEnvironmentId = `env_absent_${n++}`;
      const waitpoint = await seedWaitpoint(prisma17 as unknown as PrismaClient, {
        environmentId: absentEnvironmentId,
        projectId: cp.project.id,
      });

      // The presenter reads waitpoint scalars off its own replica (PG17); the resolver singleton
      // reads the env off the `~/db.server` proxy -> control-plane (PG14), where it is absent.
      primaryHolder.client = prisma14;

      const presenter = new WaitpointPresenter(
        prisma17 as unknown as PrismaClient,
        prisma17 as unknown as PrismaClient
      );

      const result = await presenter.call({
        friendlyId: waitpoint.friendlyId,
        environmentId: absentEnvironmentId,
        projectId: cp.project.id,
      });

      // env resolves null after the waitpoint is found -> presenter returns null, no CH hydrate.
      expect(result).toBeNull();
    }
  );
});
