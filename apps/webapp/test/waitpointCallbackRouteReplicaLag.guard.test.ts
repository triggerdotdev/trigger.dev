// Property: the HTTP-callback route reads-your-writes via a primary fallback.
//
// When the replica-routed `runStore.findWaitpoint({ where: { id } })` returns null (a token whose
// callback fires right after mint has not replicated yet), the route re-reads the OWNING PRIMARY via
// `runStore.findWaitpointOnPrimary(...)` before giving up, so a just-minted token still resolves.
//
// This drives the REAL exported route `action` end-to-end against a lagging split replica (rather
// than calling the store methods directly), so it verifies the route itself — not just the store —
// honours the fallback.
//
// The DB is never mocked: `~/db.server`'s `$replica`/`prisma` proxies forward to a real testcontainer
// (PG17). The replica proxy is wrapped so `waitpoint` reads come back empty (replication lag) while
// every other model — crucially `runtimeEnvironment`, which control-plane env resolution reads —
// forwards to the real row. The primary proxy is the unwrapped client, so `findWaitpointOnPrimary`
// sees the token. `~/v3/runEngine.server` is stubbed to a no-op by test/setup.ts, so the PENDING
// happy path reaches a real 200 without a live engine.
import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

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
    runOpsSplitReadEnabled: true,
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});

import type { PrismaClient } from "@trigger.dev/database";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { action } from "~/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId.callback.$hash";
import { generateHttpCallbackUrl } from "~/services/httpCallback.server";

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

let n = 0;
async function seedControlPlane(prisma: PrismaClient) {
  const s = n++;
  const organization = await prisma.organization.create({
    data: { title: `Org ${s}`, slug: `org-lag-${s}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `P ${s}`,
      slug: `p-lag-${s}`,
      externalRef: `proj_lag_${s}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: `env-lag-${s}`,
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_lag_${s}`,
      pkApiKey: `pk_lag_${s}`,
      shortcode: `sc_lag_${s}`,
    },
  });
  return { organization, project, environment };
}

// A just-minted MANUAL token whose `id` matches `WaitpointId.toId(friendlyId)`, so the route's
// friendlyId->id conversion + the hash (computed over `id`) line up.
async function seedJustMintedToken(
  prisma: PrismaClient,
  ctx: { environmentId: string; projectId: string },
  status: "PENDING" | "COMPLETED" = "PENDING"
) {
  const s = n++;
  const { id, friendlyId } = WaitpointId.generate();
  await prisma.waitpoint.create({
    data: {
      id,
      friendlyId,
      type: "MANUAL",
      status,
      idempotencyKey: `idem_lag_${s}`,
      userProvidedIdempotencyKey: false,
      environmentId: ctx.environmentId,
      projectId: ctx.projectId,
    },
  });
  return { id, friendlyId };
}

describe("HTTP-callback route: read-your-writes primary fallback under replica lag (real route action)", () => {
  // Happy path: a just-minted PENDING token is invisible on the (lagging) replica; the route resolves
  // it on the primary and completes it -> 200.
  heteroPostgresTest(
    "PENDING token invisible on replica resolves via primary and completes -> 200",
    async ({ prisma17 }) => {
      const cp = await seedControlPlane(prisma17 as unknown as PrismaClient);
      const token = await seedJustMintedToken(prisma17 as unknown as PrismaClient, {
        environmentId: cp.environment.id,
        projectId: cp.project.id,
      });

      const replica = laggingReplica(prisma17 as unknown as PrismaClient, [
        { model: "waitpoint", mode: "missing" },
      ]);
      primaryHolder.client = prisma17; // findWaitpointOnPrimary sees the token
      replicaHolder.client = replica.client; // findWaitpoint (+ env resolution) reads here; waitpoint starved

      // No parent env -> the hash is computed over the env's own apiKey.
      const hash = hashFor(token.id, cp.environment.apiKey);

      const res = await action({
        request: callbackRequest({ ok: true }),
        params: { waitpointFriendlyId: token.friendlyId, hash },
        context: {} as never,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });
      // The replica read genuinely fired and missed — the token was invisible there.
      expect(replica.wasHit()).toBe(true);
    }
  );

  // Independent-of-engine proof: a PENDING token with the WRONG hash resolves on the primary and the
  // hash check runs -> 401. The 401 (not a not-found) pins that the primary fallback resolves the row,
  // not that it merely masks the engine's no-op.
  heteroPostgresTest(
    "PENDING token invisible on replica resolves via primary then fails hash -> 401",
    async ({ prisma17 }) => {
      const cp = await seedControlPlane(prisma17 as unknown as PrismaClient);
      const token = await seedJustMintedToken(prisma17 as unknown as PrismaClient, {
        environmentId: cp.environment.id,
        projectId: cp.project.id,
      });

      const replica = laggingReplica(prisma17 as unknown as PrismaClient, [
        { model: "waitpoint", mode: "missing" },
      ]);
      primaryHolder.client = prisma17;
      replicaHolder.client = replica.client;

      const res = await action({
        request: callbackRequest({ ok: true }),
        params: { waitpointFriendlyId: token.friendlyId, hash: "not-the-right-hash" },
        context: {} as never,
      });

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Invalid URL, hash doesn't match" });
      expect(replica.wasHit()).toBe(true);
    }
  );
});
