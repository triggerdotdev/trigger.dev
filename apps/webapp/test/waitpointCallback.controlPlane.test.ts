// Real PG14 (control-plane) + PG17 (run-ops) proof for the HTTP-callback waitpoint
// completion route after it was decomposed onto the ControlPlaneResolver. The waitpoint
// scalar row lives on PG17 (run-ops); the env (apiKey/project/org) + its branch parent live
// on PG14 (control-plane), with the cross-seam Waitpoint FKs dropped. The route reads the
// waitpoint scalars from run-ops and resolves the authenticated env (including the parent
// apiKey the hash check uses) from control-plane. The DB is never mocked; the .count() proof
// shows neither DB joins the other.
import { heteroPostgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

// The route under test reads the waitpoint scalars off the `$replica` singleton and resolves the
// authenticated env off the module-level `controlPlaneResolver` singleton, which reads the `prisma`
// singleton (split off -> controlPlanePrimary). We point each `~/db.server` proxy at the REAL
// container holding that data: `$replica` -> run-ops (PG17), `prisma` -> control-plane (PG14). The
// DB is NEVER mocked: the proxies forward to real testcontainer clients. (The route module also
// imports the run engine, but the branches exercised here all return before `engine.completeWaitpoint`.)
const replicaHolder = vi.hoisted(() => ({ client: undefined as any }));
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
          const value = holder.client[prop];
          // The `runStore` singleton memoizes each Prisma delegate on first access, pinning it to
          // the first test's (later-dropped) DB. Re-resolve so it routes to the current client.
          if (value !== null && typeof value === "object") {
            return new Proxy(value, {
              get: (_d, method) => holder.client[prop][method],
            });
          }
          return value;
        },
      }
    );
  return {
    prisma: lazyProxy(primaryHolder, "primaryHolder.client"),
    $replica: lazyProxy(replicaHolder, "replicaHolder.client"),
    runOpsNewPrisma: lazyProxy(replicaHolder, "replicaHolder.client"),
    runOpsNewReplica: lazyProxy(replicaHolder, "replicaHolder.client"),
    runOpsLegacyReplica: lazyProxy(replicaHolder, "replicaHolder.client"),
    // The route's read-through helper reads this off `~/db.server`; split-on routes run-ops id (NEW)
    // ids to the `runOpsNewReplica` proxy, which points at the seeded container.
    runOpsSplitReadEnabled: true,
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});

import type { PrismaClient } from "@trigger.dev/database";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { action } from "~/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId.callback.$hash";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";
import { ControlPlaneCache } from "~/v3/runOpsMigration/controlPlaneCache.server";
import { ControlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

function callbackRequest(body: unknown) {
  const payload = JSON.stringify(body);
  return new Request("http://localhost/callback", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": String(payload.length) },
    body: payload,
  });
}

// Derives the same hash `verifyHttpCallbackHash` checks, via the production URL helper.
function hashFor(waitpointId: string, apiKey: string) {
  const url = generateHttpCallbackUrl(waitpointId, apiKey);
  return url.split("/").pop()!;
}

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
async function seedControlPlane(prisma: PrismaClient, opts?: { withParent?: boolean }) {
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
  const parent = opts?.withParent
    ? await prisma.runtimeEnvironment.create({
        data: {
          type: "PREVIEW",
          slug: `preview-parent-${s}`,
          projectId: project.id,
          organizationId: organization.id,
          apiKey: `tr_parent_${s}`,
          pkApiKey: `pk_parent_${s}`,
          shortcode: `sc_parent_${s}`,
        },
      })
    : null;
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: opts?.withParent ? "PREVIEW" : "PRODUCTION",
      slug: `env-${s}`,
      branchName: opts?.withParent ? "feat/x" : null,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_${s}`,
      pkApiKey: `pk_${s}`,
      shortcode: `sc_${s}`,
      parentEnvironmentId: parent?.id ?? null,
    },
  });
  return { organization, project, environment, parent };
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

describe("waitpoint HTTP-callback cross-DB read-through", () => {
  heteroPostgresTest(
    "waitpoint resolves from run-ops; env apiKey resolves from control-plane",
    async ({ prisma14, prisma17 }) => {
      await dropWaitpointCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedControlPlane(prisma14 as unknown as PrismaClient);
      const waitpoint = await seedWaitpoint(prisma17 as unknown as PrismaClient, {
        environmentId: cp.environment.id,
        projectId: cp.project.id,
      });

      // Run-ops read: waitpoint scalars only, no environment relation.
      const found = await (prisma17 as unknown as PrismaClient).waitpoint.findFirst({
        where: { id: waitpoint.id },
        select: { id: true, status: true, environmentId: true },
      });
      expect(found).not.toBeNull();
      expect(found!.environmentId).toBe(cp.environment.id);

      // Control-plane resolution of the authenticated env (passthrough mode).
      const resolver = new ControlPlaneResolver({
        controlPlanePrimary: prisma14 as unknown as PrismaClient,
        controlPlaneReplica: prisma14 as unknown as PrismaClient,
        cache: new ControlPlaneCache(),
        splitEnabled: () => false,
      });
      const env = await resolver.resolveAuthenticatedEnv(found!.environmentId);
      expect(env).not.toBeNull();
      // No parent env: the hash check falls back to the env's own apiKey.
      expect(env!.parentEnvironment?.apiKey ?? env!.apiKey).toBe(cp.environment.apiKey);
      expect(env!.organizationId).toBe(cp.organization.id);

      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).waitpoint.count()).toBe(0);
    }
  );

  heteroPostgresTest(
    "branch env: the hash check uses the parent apiKey resolved from control-plane",
    async ({ prisma14, prisma17 }) => {
      await dropWaitpointCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedControlPlane(prisma14 as unknown as PrismaClient, { withParent: true });
      const waitpoint = await seedWaitpoint(prisma17 as unknown as PrismaClient, {
        environmentId: cp.environment.id,
        projectId: cp.project.id,
      });

      const found = await (prisma17 as unknown as PrismaClient).waitpoint.findFirst({
        where: { id: waitpoint.id },
        select: { id: true, status: true, environmentId: true },
      });

      const resolver = new ControlPlaneResolver({
        controlPlanePrimary: prisma14 as unknown as PrismaClient,
        controlPlaneReplica: prisma14 as unknown as PrismaClient,
        cache: new ControlPlaneCache(),
        splitEnabled: () => false,
      });
      const env = await resolver.resolveAuthenticatedEnv(found!.environmentId);
      expect(env!.parentEnvironment).not.toBeNull();
      // The route prefers the parent apiKey for the hash check on a branch env.
      expect(env!.parentEnvironment?.apiKey ?? env!.apiKey).toBe(cp.parent!.apiKey);

      expect(await (prisma17 as unknown as PrismaClient).runtimeEnvironment.count()).toBe(0);
      expect(await (prisma14 as unknown as PrismaClient).waitpoint.count()).toBe(0);
    }
  );
});

// A waitpoint whose `id` matches `WaitpointId.toId(friendlyId)`, so the route's friendlyId->id
// conversion + the hash (computed over `id`) line up.
async function seedRoutableWaitpoint(
  prisma: PrismaClient,
  ctx: { environmentId: string; projectId: string },
  overrides?: { status?: "PENDING" | "COMPLETED"; output?: string }
) {
  const s = n++;
  const { id, friendlyId } = WaitpointId.generate();
  return prisma.waitpoint.create({
    data: {
      id,
      friendlyId,
      type: "MANUAL",
      status: overrides?.status ?? "PENDING",
      idempotencyKey: `idem_${s}`,
      userProvidedIdempotencyKey: false,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
      ...(overrides?.output
        ? { output: overrides.output, outputType: "application/json", outputIsError: false }
        : {}),
    },
  });
}

// With split on (the test env sets RUN_OPS_SPLIT_ENABLED + both DB urls), the singleton resolver
// reads the env off the control-plane REPLICA, which is the `$replica` proxy the route also reads
// the waitpoint from. So for the route-level branches we co-locate the waitpoint + its env on the
// run-ops container the proxies point at; the genuine cross-DB residency (waitpoint PG17 / env PG14)
// is already proven by the resolver-isolation cases above. The DB is never mocked.
describe("waitpoint HTTP-callback route action (real containers)", () => {
  heteroPostgresTest(
    "env resolves null (no env row) -> 404 Waitpoint not found",
    async ({ prisma17 }) => {
      await dropWaitpointCrossSeamFks(prisma17 as unknown as PrismaClient);
      // Seed the waitpoint but NOT its env, so the resolver returns null after the waitpoint is found.
      const cp = await seedControlPlane(prisma17 as unknown as PrismaClient);
      const waitpoint = await seedRoutableWaitpoint(prisma17 as unknown as PrismaClient, {
        environmentId: `env_absent_${n++}`,
        projectId: cp.project.id,
      });

      replicaHolder.client = prisma17;
      primaryHolder.client = prisma17;

      const res = await action({
        request: callbackRequest({}),
        params: { waitpointFriendlyId: waitpoint.friendlyId, hash: "deadbeef" },
        context: {} as never,
      });

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Waitpoint not found" });
    }
  );

  heteroPostgresTest("wrong hash -> 401 Invalid URL, hash doesn't match", async ({ prisma17 }) => {
    await dropWaitpointCrossSeamFks(prisma17 as unknown as PrismaClient);
    const cp = await seedControlPlane(prisma17 as unknown as PrismaClient);
    const waitpoint = await seedRoutableWaitpoint(prisma17 as unknown as PrismaClient, {
      environmentId: cp.environment.id,
      projectId: cp.project.id,
    });

    replicaHolder.client = prisma17;
    primaryHolder.client = prisma17;

    const res = await action({
      request: callbackRequest({}),
      params: { waitpointFriendlyId: waitpoint.friendlyId, hash: "not-the-right-hash" },
      context: {} as never,
    });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid URL, hash doesn't match" });
  });

  heteroPostgresTest(
    "COMPLETED waitpoint short-circuits -> 200 success without mutating the row",
    async ({ prisma17 }) => {
      await dropWaitpointCrossSeamFks(prisma17 as unknown as PrismaClient);
      const cp = await seedControlPlane(prisma17 as unknown as PrismaClient);
      const existingOutput = JSON.stringify({ already: "done" });
      const waitpoint = await seedRoutableWaitpoint(
        prisma17 as unknown as PrismaClient,
        { environmentId: cp.environment.id, projectId: cp.project.id },
        { status: "COMPLETED", output: existingOutput }
      );

      replicaHolder.client = prisma17;
      primaryHolder.client = prisma17;

      // No parent env -> the hash is computed over the env's own apiKey.
      const hash = hashFor(waitpoint.id, cp.environment.apiKey);

      const res = await action({
        request: callbackRequest({ new: "data" }),
        params: { waitpointFriendlyId: waitpoint.friendlyId, hash },
        context: {} as never,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      // The COMPLETED branch returns before `engine.completeWaitpoint`: the row is untouched.
      const after = await (prisma17 as unknown as PrismaClient).waitpoint.findFirst({
        where: { id: waitpoint.id },
        select: { status: true, output: true },
      });
      expect(after!.status).toBe("COMPLETED");
      expect(after!.output).toBe(existingOutput);
    }
  );
});
