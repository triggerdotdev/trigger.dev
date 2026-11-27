// Verifies the routes-batch-get read paths under replica lag — five external-API call sites across two
// store methods with different default routing. Each case drives the REAL exported route caller
// (loader/action) end-to-end against a real split Postgres whose owning LEGACY replica is FROZEN via
// laggingReplica; the run-store read path is real, never mocked. Only orthogonal deps are stubbed
// (bearer auth, request-idempotency cache, realtime stream, abort signal).
//
// findBatchTaskRunByFriendlyId (GET/subscribe) routes to the REPLICA: under lag a live batch reads as
// null and the resource gate returns a 404 carrying x-should-retry, which the SDK obeys — so the property
// is that the header is "true" (retryable, self-heals through lag), matching the sibling run-get routes.
// findBatchTaskRunById (dedup) routes to the PRIMARY: under owning-replica lag the just-written batch is
// still found (frozen replica never consulted), so the retried request dedups to the cached batch (200)
// instead of minting a duplicate — proven by wasHit("batchTaskRun") === false and the 200 dedup body.

import { heteroRunOpsPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import type { RunOpsPrismaClient } from "@internal/run-ops-database";
import {
  MEMORYDB_SHARD_KEY,
  organizationContext,
  PostgresRunStore,
  RoutingRunStore,
  type CreateBatchTaskRunData,
  type OrganizationContext,
  type RunStore,
} from "@internal/run-store";
import { json } from "@remix-run/server-runtime";
import { describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---- Hoisted singleton holder + a stable Proxy that forwards every run-store method to the per-test
// REAL RoutingRunStore set in holder.store. vi.mock factories (hoisted above the imports) reference
// these, so they must be created inside vi.hoisted.
const { holder, storeProxy } = vi.hoisted(() => {
  const holder = {
    store: undefined as unknown,
    environment: undefined as unknown,
    cachedRequest: null as { id: string } | null,
  };
  const storeProxy = new Proxy(
    {},
    {
      get(_target, prop) {
        const store = holder.store as Record<string | symbol, unknown> | undefined;
        if (!store) throw new Error("test bug: holder.store not initialised before caller ran");
        const value = store[prop];
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(store)
          : value;
      },
    }
  );
  return { holder, storeProxy };
});

// db.server is imported transitively by the api-builder graph; provide inert stubs so importing the
// real routes never constructs a live Prisma client. The routes never read from these — the run-store
// read path is the injected RoutingRunStore below.
vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  return { prisma: {}, $replica: {}, sqlDatabaseSchema: Prisma.sql([`public`]) };
});

// Bearer auth (orthogonal): return ok with the seeded environment + a permissive ability. The
// friendlyId loaders 404 at the resource gate BEFORE authorization, so the ability only matters for the
// two PRIMARY action sites (authorization runs before their handler).
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateBearer: async () => ({
      ok: true,
      environment: holder.environment,
      subject: { type: "private" },
      ability: { can: () => true, canSuper: () => true },
      jwt: undefined,
    }),
  },
}));

// Inject the REAL split router as the app-level run store (used by v1/v2 batch loaders, the realtime
// loader, and the v2.tasks.batch action).
vi.mock("~/v3/runStore.server", () => ({ runStore: storeProxy }));

// api.v3.batches reads through `engine.runStore`. Override test/setup.ts's no-op engine so `runStore`
// resolves to the injected router while any other engine access stays a no-op (dedup path touches none).
vi.mock("~/v3/runEngine.server", () => ({
  engine: new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "runStore") return storeProxy;
        return () => Promise.resolve(undefined);
      },
    }
  ),
}));

// Request-idempotency cache lookup (orthogonal): return whatever the test seeded. The REAL
// findCachedEntity callback then drives runStore.findBatchTaskRunById against the injected router.
vi.mock("~/services/requestIdempotencyInstance.server", () => ({
  requestIdempotency: {
    checkRequest: async () => holder.cachedRequest,
    saveRequest: async () => {},
  },
}));

// Realtime stream client (orthogonal). Under lag the realtime loader 404s at the resource gate
// before reaching it; stubbing it just keeps the import light. `getRequestAbortSignal` is likewise only
// reached on the found path, so httpAsyncStorage.server is left real (the logger needs getHttpContext).
vi.mock("~/services/realtime/resolveRealtimeStreamClient.server", () => ({
  resolveRealtimeStreamClient: async () => ({
    streamBatch: async () => new Response("stream", { status: 200 }),
  }),
}));

// The REAL callers under test.
import { loader as loaderV1 } from "~/routes/api.v1.batches.$batchId";
import { loader as loaderV2 } from "~/routes/api.v2.batches.$batchId";
import { loader as loaderRealtime } from "~/routes/realtime.v1.batches.$batchId";
import { action as actionTasksBatch } from "~/routes/api.v2.tasks.batch";
import { action as actionCreateBatch } from "~/routes/api.v3.batches";
import {
  createActionApiRoute,
  createLoaderApiRoute,
  createMultiMethodApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import {
  tenantContext,
  tenantContextFromAuthEnvironment,
  type TenantContext,
} from "~/services/tenantContext.server";
import { createRunResidencyGate } from "~/v3/utils/runResidencyGate.server";

// A cuid (25 chars after the `batch_` prefix) classifies LEGACY, so the batch is owned by the legacy
// (control-plane) store; the client-less reads then land on the LEGACY leg.
const CUID_25 = "c".repeat(25);
// Must be a v4 UUID or the route ignores the header.
const REQUEST_IDEMPOTENCY_KEY = "b3f1e9c2-5d7a-4a1b-9c8e-2f6d4a7b1c30";

let seq = 0;

async function seedEnvironment(prisma: PrismaClient, suffix: string) {
  const organization = await prisma.organization.create({
    data: { title: `Org ${suffix}`, slug: `org-${suffix}` },
  });
  const project = await prisma.project.create({
    data: {
      name: `Project ${suffix}`,
      slug: `project-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
    },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      type: "DEVELOPMENT",
      slug: "dev",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${suffix}`,
      pkApiKey: `pk_dev_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  return { organization, project, environment };
}

// Build the RoutingRunStore exactly as the webapp holds it, with the LEGACY replica frozen in "missing"
// mode for the batch models: a REPLICA-routed batch read comes back null AND flips wasHit — so a null
// result + wasHit(true) proves REPLICA routing (the friendlyId reads above), and a correct row +
// wasHit(false) proves PRIMARY routing (the dedup reads above).
function buildLaggingRouter(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const legacyReplica = laggingReplica(prisma14, [
    { model: "batchTaskRun", mode: "missing" },
    { model: "batchTaskRunItem", mode: "missing" },
  ]);
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
  const router = new RoutingRunStore({ new: newStore, legacy: legacyStore });
  return { router, legacyStore, legacyReplica };
}

function batchData(overrides: Partial<CreateBatchTaskRunData>): CreateBatchTaskRunData {
  return {
    id: `batch_${CUID_25}`,
    friendlyId: "batch_route_get_f",
    runtimeEnvironmentId: "PLACEHOLDER",
    status: "PENDING",
    runCount: 1,
    runIds: ["run_child_1"],
    expectedCount: 1,
    batchVersion: "runengine:v2",
    sealed: false,
    ...overrides,
  };
}

function getRequest(url: string, apiKey: string) {
  return new Request(url, { headers: { Authorization: `Bearer ${apiKey}` } });
}

// The slim AuthenticatedEnvironment the routes + tenantContext read. Only orthogonal fields — the
// actual batch read is keyed off `.id`.
function authEnv(seed: Awaited<ReturnType<typeof seedEnvironment>>) {
  return {
    id: seed.environment.id,
    apiKey: seed.environment.apiKey,
    type: seed.environment.type,
    slug: seed.environment.slug,
    organization: {
      id: seed.organization.id,
      slug: seed.organization.slug,
      title: seed.organization.title,
    },
    project: {
      id: seed.project.id,
      slug: seed.project.slug,
      externalRef: seed.project.externalRef,
    },
  };
}

describe("routes-batch-get callers under a lagging replica", () => {
  // ── api.v1.batches loader — findBatchTaskRunByFriendlyId (REPLICA) ───────────────────
  heteroRunOpsPostgresTest(
    "api.v1.batches loader: a live batch stale on the replica returns a retryable 404 (x-should-retry:true)",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const suffix = `bget_v1_${seq++}`;
      const seed = await seedEnvironment(prisma14, suffix);
      const friendlyId = `batch_${suffix}_f`;
      await legacyStore.createBatchTaskRun(
        batchData({ friendlyId, runtimeEnvironmentId: seed.environment.id })
      );

      holder.store = router;
      holder.environment = authEnv(seed);

      const res = (await loaderV1({
        request: getRequest(
          `http://localhost/api/v1/batches/${friendlyId}`,
          seed.environment.apiKey
        ),
        params: { batchId: friendlyId },
        context: {} as never,
      })) as Response;

      // The owning REPLICA was genuinely consulted and (frozen) missed.
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(true);
      // Real loader output: a 404 for a LIVE batch stale on the replica...
      expect(res.status).toBe(404);
      // ...but retryable → the SDK retries through lag until the replica catches up.
      expect(res.headers.get("x-should-retry")).toBe("true");
    }
  );

  // ── api.v2.batches loader — findBatchTaskRunByFriendlyId (REPLICA) ───────────────────
  heteroRunOpsPostgresTest(
    "api.v2.batches loader: client-less replica read, stale-null returns a retryable 404",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const suffix = `bget_v2_${seq++}`;
      const seed = await seedEnvironment(prisma14, suffix);
      const friendlyId = `batch_${suffix}_f`;
      await legacyStore.createBatchTaskRun(
        batchData({
          friendlyId,
          runtimeEnvironmentId: seed.environment.id,
          processingCompletedAt: new Date(),
        })
      );

      holder.store = router;
      holder.environment = authEnv(seed);

      const res = (await loaderV2({
        request: getRequest(
          `http://localhost/api/v2/batches/${friendlyId}`,
          seed.environment.apiKey
        ),
        params: { batchId: friendlyId },
        context: {} as never,
      })) as Response;

      expect(legacyReplica.wasHit("batchTaskRun")).toBe(true);
      expect(res.status).toBe(404);
      expect(res.headers.get("x-should-retry")).toBe("true");
    }
  );

  // ── realtime.v1.batches loader — replica miss recovered by the owning-primary re-read ─────────────
  // The realtime loader re-reads the owning primary on a replica miss (the ShapeStream consumer ignores
  // x-should-retry, so a 404 here would strand), so a stale-on-replica batch reaches streamBatch.
  heteroRunOpsPostgresTest(
    "realtime.v1.batches loader: a batch stale on the replica is recovered via the owning-primary re-read (reaches streamBatch, no 404)",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const suffix = `bget_rt_${seq++}`;
      const seed = await seedEnvironment(prisma14, suffix);
      const friendlyId = `batch_${suffix}_f`;
      const batchId = `batch_${CUID_25}`;
      await legacyStore.createBatchTaskRun(
        batchData({ id: batchId, friendlyId, runtimeEnvironmentId: seed.environment.id })
      );

      holder.store = router;
      holder.environment = authEnv(seed);

      const res = (await loaderRealtime({
        request: getRequest(
          `http://localhost/realtime/v1/batches/${friendlyId}`,
          seed.environment.apiKey
        ),
        params: { batchId: friendlyId },
        context: {} as never,
      })) as Response;

      // Replica was consulted first (the miss)…
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(true);
      // …then the owning-primary re-read found the live batch, so the subscription starts (streamBatch
      // returns 200) instead of a resource-gate 404.
      expect(res.status).toBe(200);
    }
  );

  // ── api.v2.tasks.batch action — findBatchTaskRunById (PRIMARY) ───────────────────────────────────────
  heteroRunOpsPostgresTest(
    "api.v2.tasks.batch action: request-idempotency dedup reads the owning primary, finding the cached batch under lag (200 dedup, no duplicate)",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const suffix = `bget_tb_${seq++}`;
      const seed = await seedEnvironment(prisma14, suffix);
      const batchId = `batch_${CUID_25}`;
      const friendlyId = `batch_${suffix}_f`;
      await legacyStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId,
          runtimeEnvironmentId: seed.environment.id,
          runCount: 5,
        })
      );

      holder.store = router;
      holder.environment = authEnv(seed);
      holder.cachedRequest = { id: batchId };

      const body = JSON.stringify({ items: [{ task: "my-task" }] });
      const res = (await actionTasksBatch({
        request: new Request("http://localhost/api/v2/tasks/batch", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
            authorization: `Bearer ${seed.environment.apiKey}`,
            "x-trigger-request-idempotency-key": REQUEST_IDEMPOTENCY_KEY,
          },
          body,
        }),
        params: {},
        context: {} as never,
      })) as Response;

      // PRIMARY routing tolerance: the frozen owning replica was NEVER consulted...
      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);
      // ...and the real action returned the cached batch (dedup), not a duplicate create.
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: friendlyId, runCount: 5 });
    }
  );

  // ── api.v3.batches action — findBatchTaskRunById (PRIMARY) ───────────────────────────────────────────
  heteroRunOpsPostgresTest(
    "api.v3.batches action: create-batch idempotency dedup reads the primary, finding the cached batch under lag (isCached 200, no duplicate)",
    async ({ prisma14, prisma17 }) => {
      const { router, legacyStore, legacyReplica } = buildLaggingRouter(prisma14, prisma17);
      const suffix = `bget_v3_${seq++}`;
      const seed = await seedEnvironment(prisma14, suffix);
      const batchId = `batch_${CUID_25}`;
      const friendlyId = `batch_${suffix}_f`;
      await legacyStore.createBatchTaskRun(
        batchData({
          id: batchId,
          friendlyId,
          runtimeEnvironmentId: seed.environment.id,
          runCount: 3,
        })
      );

      holder.store = router;
      holder.environment = authEnv(seed);
      holder.cachedRequest = { id: batchId };

      const body = JSON.stringify({ runCount: 3, idempotencyKey: "idem_v3" });
      const res = (await actionCreateBatch({
        request: new Request("http://localhost/api/v3/batches", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
            authorization: `Bearer ${seed.environment.apiKey}`,
          },
          body,
        }),
        params: {},
        context: {} as never,
      })) as Response;

      expect(legacyReplica.wasHit("batchTaskRun")).toBe(false);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: friendlyId, runCount: 3, isCached: true });
    }
  );
});

// The organisations, by their feature flags, and whether the gate opens for them.
const STAMP_AT = "2026-01-01T00:00:00.000Z";
const ORGANIZATIONS: Record<string, { featureFlags: unknown; opens: boolean }> = {
  plain: { featureFlags: null, opens: false },
  "never-on": { featureFlags: { activeRunStoreEnabled: true }, opens: false },
  "on-record-off": {
    featureFlags: { runResidencyEnabled: true, activeRunStoreEnabled: false },
    opens: false,
  },
  on: { featureFlags: { runResidencyEnabled: true, activeRunStoreEnabled: true }, opens: true },
  "was-on": {
    featureFlags: {
      runResidencyEnabled: false,
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: STAMP_AT,
      activeRunStoreEnabled: true,
    },
    opens: true,
  },
};

function environmentOf(seed: Awaited<ReturnType<typeof seedEnvironment>>, featureFlags: unknown) {
  const environment = authEnv(seed);
  return { ...environment, organization: { ...environment.organization, featureFlags } };
}

// Records each call of a store method as "<name>:<method>", forwarding it bound to the store
// (PostgresRunStore's private fields fail an unbound call). Other properties pass through.
function recorded<T extends object>(store: T, name: string, log: string[]): T {
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        log.push(`${name}:${String(prop)}`);
        return value.apply(target, args);
      };
    },
  });
}

// The router without m, and the router buildRunStore's split arm builds with a stand-in under m
// and the webapp's gate, both over the same recorded Postgres stores.
function buildRouters(prisma14: PrismaClient, prisma17: RunOpsPrismaClient) {
  const log: string[] = [];
  const lookups: string[] = [];
  const legacy = recorded(
    new PostgresRunStore({ prisma: prisma14, readOnlyPrisma: prisma14, schemaVariant: "legacy" }),
    "legacy",
    log
  );
  const newStore = recorded(
    new PostgresRunStore({
      prisma: prisma17 as never,
      readOnlyPrisma: prisma17 as never,
      schemaVariant: "dedicated",
    }),
    "new",
    log
  );
  const standIn = {
    findBatchTaskRunByFriendlyId: async () => {
      log.push("m:findBatchTaskRunByFriendlyId");
      return null;
    },
    findBatchTaskRunById: async () => {
      log.push("m:findBatchTaskRunById");
      return null;
    },
  } as unknown as RunStore;
  const withoutM = new RoutingRunStore({ new: newStore, legacy });
  const gated = new RoutingRunStore({
    new: newStore,
    legacy,
    shards: [{ key: MEMORYDB_SHARD_KEY, store: standIn }],
    memoryDbGate: createRunResidencyGate({
      readGlobalFlags: () => ({}),
      resolveAuthenticatedEnv: async (environmentId) => {
        lookups.push(environmentId);
        return null;
      },
    }),
  });
  return { log, lookups, withoutM, gated, legacy };
}

type Routers = ReturnType<typeof buildRouters>;

// One request on each router, clearing the log between them.
async function onBothRouters(routers: Routers, request: () => Promise<Response>) {
  const results = [];
  for (const router of [routers.withoutM, routers.gated]) {
    routers.log.length = 0;
    holder.store = router;
    const res = await request();
    results.push({ status: res.status, body: await res.json(), log: [...routers.log] });
  }
  const [withoutM, gated] = results;
  return { withoutM, gated };
}

const memoryDbCalls = (log: string[]) => log.filter((entry) => entry.startsWith("m:"));

async function seedBatch(routers: Routers, prisma14: PrismaClient, suffix: string) {
  const seed = await seedEnvironment(prisma14, suffix);
  const friendlyId = `batch_${suffix}_f`;
  const batchId = `batch_${CUID_25}`;
  await routers.legacy.createBatchTaskRun(
    batchData({ id: batchId, friendlyId, runtimeEnvironmentId: seed.environment.id, runCount: 2 })
  );
  return { seed, friendlyId, batchId };
}

function batchGet(friendlyId: string, apiKey: string) {
  return async () =>
    (await loaderV1({
      request: getRequest(`http://localhost/api/v1/batches/${friendlyId}`, apiKey),
      params: { batchId: friendlyId },
      context: {} as never,
    })) as Response;
}

function batchTriggerDedup(apiKey: string) {
  return async () => {
    const body = JSON.stringify({ items: [{ task: "my-task" }] });
    return (await actionTasksBatch({
      request: new Request("http://localhost/api/v2/tasks/batch", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          authorization: `Bearer ${apiKey}`,
          "x-trigger-request-idempotency-key": REQUEST_IDEMPOTENCY_KEY,
        },
        body,
      }),
      params: {},
      context: {} as never,
    })) as Response;
  };
}

describe("organisation context on request paths", () => {
  // Catches: a builder that runs findResource or the handler outside the organisation context,
  // or leaves the context in force after the request.
  it("each of the three builders carries the environment's organisation context", async () => {
    const featureFlags = { runResidencyEnabled: true, activeRunStoreEnabled: true };
    const environment = {
      id: "env_1",
      apiKey: "tr_dev_1",
      type: "DEVELOPMENT",
      slug: "dev",
      organization: { id: "org_1", slug: "org-1", title: "Org 1", featureFlags },
      project: { id: "project_1", slug: "project-1", externalRef: "proj_1" },
    };
    holder.environment = environment;
    const expectedTenant = tenantContextFromAuthEnvironment(environment as never);
    const seen: Array<{ at: string; org?: OrganizationContext; tenant?: TenantContext }> = [];
    const observe = (at: string) =>
      seen.push({ at, org: organizationContext.get(), tenant: tenantContext.get() });
    const handler = async () => {
      observe("handler");
      return json({ ok: true });
    };
    const findResource = async () => {
      observe("findResource");
      return { id: "resource" };
    };

    const loader = createLoaderApiRoute({ findResource }, handler);
    const { action } = createActionApiRoute({ findResource }, handler);
    const multi = createMultiMethodApiRoute({ methods: { POST: { handler } } });
    const request = (method: string) =>
      new Request("http://localhost/api/synthetic", {
        method,
        headers: { authorization: "Bearer tr_dev_1" },
      });

    for (const [name, call] of [
      ["loader", () => loader({ request: request("GET"), params: {}, context: {} } as never)],
      ["action", () => action({ request: request("POST"), params: {}, context: {} } as never)],
      ["multi", () => multi.action({ request: request("POST"), params: {}, context: {} } as never)],
    ] as const) {
      seen.length = 0;
      const res = (await call()) as Response;
      expect({ name, status: res.status }).toEqual({ name, status: 200 });
      expect(seen.map((s) => s.at)).toEqual(
        name === "multi" ? ["handler"] : ["findResource", "handler"]
      );
      for (const s of seen) {
        expect(s.org).toEqual({ organizationId: "org_1", environmentId: "env_1", featureFlags });
        expect(s.org?.featureFlags).toBe(featureFlags);
        expect(s.tenant).toEqual(s.at === "handler" ? expectedTenant : undefined);
      }
      expect(organizationContext.get()).toBeUndefined();
    }
  });

  // Catches: a builder that keeps one context per environment across requests, so a flag change,
  // "born here" or a look-up carries over from an earlier request.
  it("gives each request for the same environment its own organisation context", async () => {
    const lookups: string[] = [];
    const gate = createRunResidencyGate({
      readGlobalFlags: () => ({}),
      resolveAuthenticatedEnv: async (environmentId) => {
        lookups.push(environmentId);
        return { organization: { featureFlags: ORGANIZATIONS.on.featureFlags } };
      },
    });
    const answers: Array<{ opens: boolean; bornHere: boolean }> = [];
    const loader = createLoaderApiRoute(
      { findResource: async () => ({ id: "resource" }) },
      async () => {
        answers.push({ opens: await gate.organizationOpens(), bornHere: gate.bornHere() });
        organizationContext.markBornHere();
        return json({ ok: true });
      }
    );
    const requestWith = async (organization: Record<string, unknown>) => {
      holder.environment = {
        id: "env_same",
        apiKey: "tr_dev_same",
        type: "DEVELOPMENT",
        slug: "dev",
        organization: { id: "org_same", slug: "org-same", title: "Org same", ...organization },
        project: { id: "project_same", slug: "project-same", externalRef: "proj_same" },
      };
      const res = (await loader({
        request: new Request("http://localhost/api/synthetic", {
          headers: { authorization: "Bearer tr_dev_same" },
        }),
        params: {},
        context: {},
      } as never)) as Response;
      expect(res.status).toBe(200);
    };

    await requestWith({ featureFlags: ORGANIZATIONS.plain.featureFlags });
    await requestWith({ featureFlags: ORGANIZATIONS.on.featureFlags });
    await requestWith({ featureFlags: ORGANIZATIONS["never-on"].featureFlags });
    // No flags in hand: each request looks up for itself.
    await requestWith({});
    await requestWith({});

    expect(answers).toEqual([
      { opens: false, bornHere: false },
      { opens: true, bornHere: false },
      { opens: false, bornHere: false },
      { opens: true, bornHere: false },
      { opens: true, bornHere: false },
    ]);
    expect(lookups).toEqual(["env_same", "env_same"]);
  });

  // Catches: a closed gate that still asks the store under m, changes the Postgres legs, or looks
  // up flags a request already holds.
  heteroRunOpsPostgresTest(
    "a closed gate leaves the request as on the router without m",
    async ({ prisma14, prisma17 }) => {
      const routers = buildRouters(prisma14, prisma17);
      const { seed, friendlyId, batchId } = await seedBatch(routers, prisma14, `org_ctx_c${seq++}`);
      holder.cachedRequest = { id: batchId };

      for (const name of ["plain", "never-on", "on-record-off"]) {
        holder.environment = environmentOf(seed, ORGANIZATIONS[name].featureFlags);
        for (const [route, request] of [
          ["batch get", batchGet(friendlyId, seed.environment.apiKey)],
          ["batch trigger dedup", batchTriggerDedup(seed.environment.apiKey)],
        ] as const) {
          const { withoutM, gated } = await onBothRouters(routers, request);
          expect({ name, route, status: withoutM.status }).toEqual({ name, route, status: 200 });
          expect(withoutM.log.some((entry) => entry.startsWith("legacy:"))).toBe(true);
          expect({ name, route, ...gated }).toEqual({ name, route, ...withoutM });
          expect(memoryDbCalls(gated.log)).toEqual([]);
        }
      }

      // No context: no scope, an empty scope, and a scope with flags but no environment.
      const on = ORGANIZATIONS.on.featureFlags;
      const noContext: Array<[string, <T>(fn: () => T) => T]> = [
        ["no scope", (fn) => fn()],
        ["empty scope", (fn) => organizationContext.run({}, fn)],
        [
          "no environment",
          (fn) => organizationContext.run({ organizationId: "org_x", featureFlags: on }, fn),
        ],
      ];
      for (const [name, inScope] of noContext) {
        const results = [];
        for (const router of [routers.withoutM, routers.gated]) {
          routers.log.length = 0;
          const row = await inScope(() =>
            router.findBatchTaskRunByFriendlyId(friendlyId, seed.environment.id)
          );
          results.push({ friendlyId: row?.friendlyId, log: [...routers.log] });
        }
        expect(results[0].friendlyId).toBe(friendlyId);
        expect({ name, ...results[1] }).toEqual({ name, ...results[0] });
        expect(memoryDbCalls(results[1].log)).toEqual([]);
      }

      expect(routers.lookups).toEqual([]);
    }
  );

  // Catches: an open gate that does not reach the store under m from a request, or changes the
  // answer when the store under m has no row.
  heteroRunOpsPostgresTest(
    "an open gate asks the store under m once per request, with the same answer",
    async ({ prisma14, prisma17 }) => {
      const routers = buildRouters(prisma14, prisma17);
      const { seed, friendlyId, batchId } = await seedBatch(routers, prisma14, `org_ctx_o${seq++}`);
      holder.cachedRequest = { id: batchId };

      for (const name of ["on", "was-on"]) {
        holder.environment = environmentOf(seed, ORGANIZATIONS[name].featureFlags);
        for (const [route, request, method] of [
          [
            "batch get",
            batchGet(friendlyId, seed.environment.apiKey),
            "m:findBatchTaskRunByFriendlyId",
          ],
          [
            "batch trigger dedup",
            batchTriggerDedup(seed.environment.apiKey),
            "m:findBatchTaskRunById",
          ],
        ] as const) {
          const { withoutM, gated } = await onBothRouters(routers, request);
          expect({ name, route, status: withoutM.status }).toEqual({ name, route, status: 200 });
          expect({ name, route, status: gated.status, body: gated.body }).toEqual({
            name,
            route,
            status: withoutM.status,
            body: withoutM.body,
          });
          expect({ name, route, m: memoryDbCalls(gated.log) }).toEqual({
            name,
            route,
            m: [method],
          });
        }
      }

      expect(routers.lookups).toEqual([]);
    }
  );
});
