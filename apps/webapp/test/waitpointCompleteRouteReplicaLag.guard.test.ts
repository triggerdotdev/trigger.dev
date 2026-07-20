// Property: under split replica lag the dashboard "complete waitpoint" route action still completes a
// just-minted token. It resolves the waitpoint by id via findWaitpoint (owning REPLICA), and on a null
// re-reads via findWaitpointOnPrimary before the projectId guard, so a token invisible on the lagging
// replica passes the guard and completion proceeds instead of failing with "No waitpoint found".
// Drives the REAL exported action; only peripheral collaborators are mocked. The seam — runStore over a
// split topology whose owning replica is frozen — is a REAL RoutingRunStore over real testcontainer
// Postgres.

import { describe, expect, vi } from "vitest";

const runStoreHolder = vi.hoisted(() => ({ store: undefined as any }));
// $replica.project.findUnique — return the seeded project id so the guard's only remaining variable
// is whether the waitpoint read resolved (this read hits `project`, never the lagging `waitpoint`).
const projectHolder = vi.hoisted(() => ({ id: undefined as string | undefined }));
const engineHolder = vi.hoisted(() => ({ calls: [] as any[] }));

vi.mock("~/v3/runStore.server", () => ({
  get runStore() {
    return runStoreHolder.store;
  },
}));

vi.mock("~/db.server", () => ({
  $replica: {
    project: {
      findUnique: async () => (projectHolder.id ? { id: projectHolder.id } : null),
    },
  },
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    completeWaitpoint: async (args: any) => {
      engineHolder.calls.push(args);
      return { id: args.id };
    },
  },
}));

vi.mock("~/services/session.server", () => ({
  requireUserId: async () => "user_test",
}));

vi.mock("~/env.server", () => ({
  env: { TASK_PAYLOAD_MAXIMUM_SIZE: 3_000_000 },
}));

vi.mock("~/services/logger.server", () => ({
  logger: { error: () => {}, info: () => {}, debug: () => {}, warn: () => {} },
}));

// Distinguishable stand-ins for the redirect helpers so we can read the outcome + message off the
// action's return without the real session-cookie machinery.
vi.mock("~/models/message.server", () => ({
  redirectWithErrorMessage: (redirect: string, _req: unknown, message: string) =>
    new Response(null, {
      status: 302,
      headers: { location: redirect, "x-outcome": "error", "x-message": message },
    }),
  redirectWithSuccessMessage: (redirect: string, _req: unknown, message: string) =>
    new Response(null, {
      status: 302,
      headers: { location: redirect, "x-outcome": "success", "x-message": message },
    }),
}));

// MANUAL-branch collaborators — the token completion path resolves the env then completes. Return an
// env whose id matches the seeded waitpoint's environmentId so the env guard passes.
const envHolder = vi.hoisted(() => ({ id: undefined as string | undefined }));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => (envHolder.id ? { id: envHolder.id } : null),
}));
vi.mock("~/runEngine/concerns/waitpointCompletionPacket.server", () => ({
  processWaitpointCompletionPacket: async () => ({ data: undefined, dataType: "application/json" }),
}));

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import { PostgresRunStore, RoutingRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.$waitpointFriendlyId.complete/route";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const WAITPOINT_CROSS_SEAM_FKS = [
  "Waitpoint_environmentId_fkey",
  "Waitpoint_projectId_fkey",
] as const;

async function dropWaitpointCrossSeamFks(prisma: PrismaClient) {
  for (const c of WAITPOINT_CROSS_SEAM_FKS) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "Waitpoint" DROP CONSTRAINT IF EXISTS "${c}"`);
  }
}

// Seed a standalone PENDING MANUAL token on the writer, exactly as minting a resume token does.
async function seedPendingTokenWaitpoint(
  store: PostgresRunStore,
  params: {
    id: string;
    friendlyId: string;
    projectId: string;
    environmentId: string;
    type?: "MANUAL" | "DATETIME";
  }
) {
  await store.upsertWaitpoint({
    where: {
      environmentId_idempotencyKey: {
        environmentId: params.environmentId,
        idempotencyKey: params.id,
      },
    },
    create: {
      id: params.id,
      friendlyId: params.friendlyId,
      type: params.type ?? "MANUAL",
      status: "PENDING",
      idempotencyKey: params.id,
      userProvidedIdempotencyKey: false,
      projectId: params.projectId,
      environmentId: params.environmentId,
    },
    update: {},
  });
}

function completeRequest(kind: "MANUAL" | "DATETIME") {
  const body = new URLSearchParams();
  body.set("type", kind);
  if (kind === "MANUAL") body.set("payload", "{}");
  body.set("successRedirect", "/success");
  body.set("failureRedirect", "/failure");
  return new Request("http://localhost/complete", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

const params = (friendlyId: string) => ({
  organizationSlug: "org-slug",
  projectParam: "proj-slug",
  envParam: "dev",
  waitpointFriendlyId: friendlyId,
});

describe("complete-waitpoint dashboard route reads-your-writes under split replica lag", () => {
  // LEGACY-resident (cuid) token minted on the control-plane writer; its replica lags. The action's
  // findWaitpoint(id) misses, and the findWaitpointOnPrimary fallback must resolve it so the just-
  // minted token passes the projectId guard and completes — NOT "No waitpoint found".
  heteroRunOpsPostgresTest(
    "MANUAL token invisible on the lagging owning replica completes via the primary fallback",
    async ({ prisma14, prisma17 }) => {
      const legacyReplica = laggingReplica(prisma14, [{ model: "waitpoint", mode: "missing" }]);
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica.client,
        schemaVariant: "legacy",
      });
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });
      runStoreHolder.store = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      await dropWaitpointCrossSeamFks(prisma14 as unknown as PrismaClient);

      // id = WaitpointId.toId(friendlyId): the route computes the internal id from the friendly id,
      // so the DB id must be exactly that bare cuid (classifies LEGACY -> control-plane store).
      const { id: waitpointId, friendlyId } = WaitpointId.generate();
      const projectId = "proj_wc_route_leg";
      const environmentId = "env_wc_route_leg";
      projectHolder.id = projectId;
      envHolder.id = environmentId;
      engineHolder.calls = [];

      await seedPendingTokenWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId,
        projectId,
        environmentId,
      });

      const res = (await action({
        request: completeRequest("MANUAL"),
        params: params(friendlyId),
        context: {} as never,
      })) as Response;

      // Property: the frozen replica was consulted (so the miss is real), yet the token completed via
      // the owning-primary re-read — success, engine invoked, and NOT "No waitpoint found".
      expect(legacyReplica.wasHit()).toBe(true);
      expect(res.headers.get("x-outcome")).toBe("success");
      expect(res.headers.get("x-message")).toBe("Waitpoint completed");
      expect(res.headers.get("x-message")).not.toBe("No waitpoint found");
      expect(engineHolder.calls).toHaveLength(1);
      expect(engineHolder.calls[0].id).toBe(waitpointId);
    }
  );

  // Same seam via the DATETIME "skip" branch (also gated by the shared projectId guard). Kept as a
  // second, mock-light assertion of the fallback so the guard doesn't hinge on MANUAL-branch helpers.
  heteroRunOpsPostgresTest(
    "DATETIME skip on a lag-invisible token resolves via the primary fallback",
    async ({ prisma14, prisma17 }) => {
      const legacyReplica = laggingReplica(prisma14, [{ model: "waitpoint", mode: "missing" }]);
      const legacyStore = new PostgresRunStore({
        prisma: prisma14,
        readOnlyPrisma: legacyReplica.client,
        schemaVariant: "legacy",
      });
      const newStore = new PostgresRunStore({
        prisma: prisma17 as never,
        readOnlyPrisma: prisma17 as never,
        schemaVariant: "dedicated",
      });
      runStoreHolder.store = new RoutingRunStore({ new: newStore, legacy: legacyStore });

      await dropWaitpointCrossSeamFks(prisma14 as unknown as PrismaClient);

      const { id: waitpointId, friendlyId } = WaitpointId.generate();
      const projectId = "proj_wc_route_dt";
      const environmentId = "env_wc_route_dt";
      projectHolder.id = projectId;
      envHolder.id = environmentId;
      engineHolder.calls = [];

      await seedPendingTokenWaitpoint(legacyStore, {
        id: waitpointId,
        friendlyId,
        projectId,
        environmentId,
        type: "DATETIME",
      });

      const res = (await action({
        request: completeRequest("DATETIME"),
        params: params(friendlyId),
        context: {} as never,
      })) as Response;

      expect(legacyReplica.wasHit()).toBe(true);
      expect(res.headers.get("x-outcome")).toBe("success");
      expect(res.headers.get("x-message")).toBe("Waitpoint skipped");
      expect(engineHolder.calls).toHaveLength(1);
      expect(engineHolder.calls[0].id).toBe(waitpointId);
    }
  );
});
