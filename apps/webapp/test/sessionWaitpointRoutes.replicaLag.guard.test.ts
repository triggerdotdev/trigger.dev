// Replica-lag properties for the route-session-waitpoint reads. Each case drives the REAL route handler
// createActionApiRoute wraps + exports as `action` (captured from the builder, not reimplemented)
// against a real Postgres (heteroPostgresTest) whose read replica is FROZEN via the shared
// `laggingReplica` primitive; only orthogonal deps are mocked (auth/session resolution, route-builder
// middleware, downstream swap/engine services, logging).
//
// end-and-continue calling-run resolve: a live calling run absent on the replica is recovered via the
//   owning-primary re-read (findRunOnPrimary), so the handoff swap is reached rather than a 404.
// waitpoint-token complete lookup: a client-less findWaitpoint misses the just-minted token on the
//   replica, yet the owning-primary re-read (findWaitpointOnPrimary) resolves it and the waitpoint
//   completes (200), reaching engine.completeWaitpoint.

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { WaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---- Hoisted holders wired per-test before the captured handler runs. ---------------------------
const H = vi.hoisted(() => ({
  store: undefined as any, // the REAL PostgresRunStore for the current case (mocked runStore forwards here)
  primary: undefined as any, // db.server `prisma` -> the real container (owning primary / writer)
  replica: undefined as any, // db.server `$replica` -> the lagging replica over the same container
  swap: { calls: [] as any[], result: undefined as any }, // swapSessionRun recorder + canned result
  engine: { calls: [] as any[] }, // engine.completeWaitpoint recorder
  handlers: [] as Array<{ config: any; handler: any }>, // captured inner handlers, one per route import
}));

// ~/db.server: lazy proxies that always resolve through the holder so the run-store singleton's
// memoized delegates route to the current test's client. Never mocks the DB itself.
vi.mock("~/db.server", () => {
  const lazyProxy = (key: "primary" | "replica", label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          const client = H[key];
          if (!client) throw new Error(`${label} not set for this test`);
          const value = client[prop];
          if (value !== null && typeof value === "object") {
            return new Proxy(value, { get: (_d, method) => H[key][prop][method] });
          }
          return value;
        },
      }
    );
  return {
    prisma: lazyProxy("primary", "H.primary"),
    $replica: lazyProxy("replica", "H.replica"),
    runOpsNewPrismaClient: undefined,
    runOpsNewReplicaClient: undefined,
    runOpsLegacyPrisma: undefined,
    runOpsLegacyReplica: undefined,
  };
});

// The REAL split router / PostgresRunStore is injected per-test into H.store; the mocked singleton is
// a stable Proxy forwarding every method to it. This is what the routes read/write through.
vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const store = H.store;
        if (!store) throw new Error("test bug: H.store not initialised before handler ran");
        const value = store[prop];
        return typeof value === "function" ? value.bind(store) : value;
      },
    }
  ),
}));

// Route builder: capture the inner handler each route hands to createActionApiRoute so we can drive
// the REAL caller directly, bypassing only the auth/body middleware (orthogonal).
vi.mock("~/services/routeBuilders/apiBuilder.server", () => ({
  anyResource: (x: unknown) => x,
  createActionApiRoute: (config: any, handler: any) => {
    H.handlers.push({ config, handler });
    return { action: vi.fn(), loader: vi.fn() };
  },
}));

// Session resolution lives in `findResource` (which we bypass by passing `resource` directly); stub so
// the heavy realtime import graph never evaluates.
vi.mock("~/services/realtime/sessions.server", () => ({
  resolveSessionByIdOrExternalId: vi.fn(async () => null),
}));

// Downstream swap is engine/realtime work, not the read under test: record the call + return a canned
// result so the success branch (and its read-after-write findRun on the primary) is exercised.
vi.mock("~/services/realtime/sessionRunManager.server", () => ({
  swapSessionRun: vi.fn(async (params: any) => {
    H.swap.calls.push(params);
    return H.swap.result;
  }),
}));

// Waitpoint completion downstream: orthogonal. Record the engine call; canned packet.
vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    completeWaitpoint: vi.fn(async (args: any) => {
      H.engine.calls.push(args);
      return { id: args.id };
    }),
  },
}));
vi.mock("~/runEngine/concerns/waitpointCompletionPacket.server", () => ({
  processWaitpointCompletionPacket: vi.fn(async () => ({
    data: "OK",
    dataType: "application/json",
  })),
}));

vi.mock("~/env.server", () => ({
  env: { TASK_PAYLOAD_MAXIMUM_SIZE: 3 * 1024 * 1024 },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";

let seq = 0;

async function seedTenant(prisma: PrismaClient, suffix: string) {
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

function buildCreateRunInput(p: {
  runId: string;
  friendlyId: string;
  organizationId: string;
  projectId: string;
  runtimeEnvironmentId: string;
}): CreateRunInput {
  return {
    data: {
      id: p.runId,
      engine: "V2",
      status: "PENDING",
      friendlyId: p.friendlyId,
      runtimeEnvironmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: p.organizationId,
      projectId: p.projectId,
      taskIdentifier: "my-task",
      payload: '{"hello":"world"}',
      payloadType: "application/json",
      context: { foo: "bar" },
      traceContext: { trace: "ctx" },
      traceId: "trace_1",
      spanId: "span_1",
      runTags: [],
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
    },
    snapshot: {
      engine: "V2",
      executionStatus: "RUN_CREATED",
      description: "Run was created",
      runStatus: "PENDING",
      environmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

// Import the target route once and return the inner handler the builder captured for it. Matching on
// the zod params shape keeps this robust regardless of import order.
async function loadHandler(modulePath: string, paramKey: string) {
  await import(modulePath);
  const entry = H.handlers.find((h) => {
    try {
      return Boolean(h.config?.params?.shape?.[paramKey]);
    } catch {
      return false;
    }
  });
  if (!entry) throw new Error(`handler for ${modulePath} (param ${paramKey}) not captured`);
  return entry.handler as (args: any) => Promise<Response>;
}

describe("route-session-waitpoint reads under replica lag", () => {
  // end-and-continue calling-run resolve
  heteroPostgresTest(
    "end-and-continue: a live calling run absent on the replica is recovered via the primary re-read",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `eac_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      // Seed the calling run on the PRIMARY only; the lagging replica will not see it.
      const runId = `run_${"a".repeat(21)}${seq}`;
      const friendlyId = `run_call_${suffix}`;
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.createRun(
        buildCreateRunInput({
          runId,
          friendlyId,
          organizationId: seed.organization.id,
          projectId: seed.project.id,
          runtimeEnvironmentId: seed.environment.id,
        })
      );

      const replica = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);

      // The run-store the mocked singleton forwards to: writer + readReplica both the real container,
      // so findRunOnPrimary (this.prisma) hits and the read-after-write findRun(prisma) hits.
      H.store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      H.primary = prisma; // db.server `prisma`
      H.replica = replica.client; // db.server `$replica` -> lagging (the client the route passes to findRun)
      H.swap = { calls: [], result: { runId, swapped: true } };

      const handler = await loadHandler(
        "~/routes/api.v1.sessions.$session.end-and-continue",
        "session"
      );

      const session = {
        id: `session_${suffix}`,
        friendlyId: `session_${suffix}`,
        externalId: null,
        closedAt: null,
        expiresAt: null,
      };

      const res = await handler({
        authentication: { environment: seed.environment },
        params: { session: session.friendlyId },
        body: { callingRunId: friendlyId, reason: "upgrade" },
        resource: session,
      });

      // The replica WAS consulted (frozen -> missed): the read genuinely went through the lagging
      // replica, so recovery is the primary re-read, not a lucky replica hit.
      expect(replica.wasHit("taskRun")).toBe(true);

      // The primary re-read resolved the calling run, so the swap was reached with its cuid...
      expect(H.swap.calls).toHaveLength(1);
      expect(H.swap.calls[0].callingRunId).toBe(runId);

      // ...and the handler returned 200 with the handoff body, not a 404.
      expect(res.status).toBe(200);
      const body = (await res.clone().json()) as {
        runId?: string;
        swapped?: boolean;
        error?: string;
      };
      expect(body.swapped).toBe(true);
      expect(body.runId).toBe(friendlyId);
      expect(body.error).toBeUndefined();
    }
  );

  // waitpoint-token complete lookup
  heteroPostgresTest(
    "waitpoint-token complete: a token absent on the replica is resolved via the primary re-read and completes",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `wctok_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const waitpointFriendlyId = `waitpoint_${"b".repeat(21)}${seq}`;
      const waitpointId = WaitpointId.toId(waitpointFriendlyId);

      // Seed a still-PENDING MANUAL token waitpoint on the PRIMARY only.
      const writerStore = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
      await writerStore.upsertWaitpoint({
        where: {
          environmentId_idempotencyKey: {
            environmentId: seed.environment.id,
            idempotencyKey: waitpointId,
          },
        },
        create: {
          id: waitpointId,
          friendlyId: waitpointFriendlyId,
          type: "MANUAL",
          status: "PENDING",
          idempotencyKey: waitpointId,
          userProvidedIdempotencyKey: false,
          projectId: seed.project.id,
          environmentId: seed.environment.id,
        },
        update: {},
      });

      // findWaitpoint is client-less in the route -> owning REPLICA (readOnlyPrisma). Freeze it.
      const replica = laggingReplica(prisma, [{ model: "waitpoint", mode: "missing" }]);
      H.store = new PostgresRunStore({ prisma, readOnlyPrisma: replica.client });
      H.primary = prisma;
      H.replica = prisma; // not used by this route, but a valid client
      H.engine = { calls: [] };

      const handler = await loadHandler(
        "~/routes/api.v1.waitpoints.tokens.$waitpointFriendlyId.complete",
        "waitpointFriendlyId"
      );

      const res = await handler({
        authentication: { environment: seed.environment },
        params: { waitpointFriendlyId },
        body: { data: { ok: true } },
      });

      // The replica WAS consulted (frozen -> missed) on the client-less findWaitpoint...
      expect(replica.wasHit("waitpoint")).toBe(true);

      // ...yet the existing findWaitpointOnPrimary fallback resolved the token, so the real handler
      // completed the waitpoint (200 success) rather than 404ing it.
      expect(res.status).toBe(200);
      const body = (await res.clone().json()) as { success?: boolean; error?: string };
      expect(body.success).toBe(true);
      expect(body.error).toBeUndefined();

      // The completion actually reached the engine with the resolved waitpoint id.
      expect(H.engine.calls).toHaveLength(1);
      expect(H.engine.calls[0].id).toBe(waitpointId);
    }
  );
});
