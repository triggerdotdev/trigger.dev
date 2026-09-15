// Property: every realtime-stream route resolves a live run under replica lag. Each case drives the
// REAL exported loader/action from a webapp route module against a REAL Postgres testcontainer whose
// replica is FROZEN via the shared `laggingReplica` (taskRun "missing"). The REAL webapp `runStore`
// singleton is built over the mocked `~/db.server` handles as the single-DB webapp holds it
// (prisma = writer/primary, $replica = frozen replica; split handles undefined → single passthrough
// store). Only peripherals are mocked: bearer/rbac + dashboard-session auth, project/env slug
// resolvers, the downstream realtime backends (S2 / native), the run engine + waitpoint caches, the
// control-plane env resolver. The run READ and the found/not-found decision run for real.
//
// Each route reads the run from the REPLICA (`runStore.findRun(..., $replica)` or a client-less
// findRun served from readOnlyPrisma). Under lag a run present on the owning PRIMARY reads back null;
// the primary re-read (`run ?? runStore.findRunOnPrimary(where, args)`) resolves it, so every case
// gets PAST the run 404 (asserted on the caller's real Response).

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// --- Holders wired per-test into the mocked module singletons ------------------------------------
// `primaryHolder.client` -> the real container (writer / owning primary).
// `replicaHolder.client` -> the frozen replica over the SAME container (taskRun reads come back null).
const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const replicaHolder = vi.hoisted(() => ({ client: undefined as any }));

// The authenticated environment the (mocked) auth resolves to + the dashboard project/session it
// resolves. Filled per-test from the seeded tenant so the routes' run reads scope correctly.
const ctx = vi.hoisted(() => ({
  environment: undefined as any,
  project: undefined as any,
  session: undefined as any,
  userId: "user_realtime_guard",
}));

// A single marker class used for BOTH the S2 backend mock and the getRealtimeStreamInstance mock, so
// the routes' `instanceof S2RealtimeStreams` checks pass. Every method returns a marker Response /
// benign value — reaching any of them proves the run read was tolerated (got past the 404).
const streamMarker = vi.hoisted(() => {
  class S2Marker {
    streamResponse() {
      return new Response("marker:streamResponse", { status: 200 });
    }
    streamResponseFromSessionStream() {
      return new Response("marker:sessionStream", { status: 200 });
    }
    ingestData() {
      return new Response("marker:ingestData", { status: 200 });
    }
    async initializeStream() {
      return { responseHeaders: {} as Record<string, string> };
    }
    async appendPart() {
      return undefined;
    }
    async getLastChunkIndex() {
      return 0;
    }
    async readRecords() {
      return [] as any[];
    }
    async readSessionStreamRecords() {
      return [] as any[];
    }
  }
  return { S2Marker };
});

// ~/db.server: stable lazy proxies (captured by the runStore singleton at first import) that forward
// every access to the current test's client. Run-ops split handles undefined → single passthrough
// store (writer = prisma, replica = $replica) — the exact single-DB webapp topology this property
// lives in. Never mocks the DB itself.
vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) throw new Error(`${label} not set for this test`);
          const value = holder.client[prop];
          if (value !== null && typeof value === "object") {
            return new Proxy(value, { get: (_d, method) => holder.client[prop][method] });
          }
          return value;
        },
      }
    );
  return {
    prisma: lazyProxy(primaryHolder, "primaryHolder.client"),
    $replica: lazyProxy(replicaHolder, "replicaHolder.client"),
    runOpsNewPrismaClient: undefined,
    runOpsNewReplicaClient: undefined,
    runOpsLegacyPrisma: undefined,
    runOpsLegacyReplica: undefined,
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});

// Bearer/JWT auth for the API-builder routes (createLoaderApiRoute / createActionApiRoute call
// rbac.authenticateBearer). Passing auth + permissive ability; the run read is unaffected.
vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateBearer: async () => ({
      ok: true,
      environment: ctx.environment,
      subject: { type: "private" },
      ability: { can: () => true, canSuper: () => true },
      jwt: undefined,
    }),
  },
}));

// Dashboard-session auth + slug resolvers for the resources.* routes (peripheral).
vi.mock("~/services/session.server", () => ({
  requireUserId: async () => ctx.userId,
  getUserId: async () => ctx.userId,
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ctx.project,
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ctx.environment,
}));

// Downstream realtime backends: markers. Reaching them proves the run read was tolerated.
vi.mock("~/services/realtime/s2realtimeStreams.server", () => ({
  S2RealtimeStreams: streamMarker.S2Marker,
}));
vi.mock("~/services/realtime/v1StreamsGlobal.server", () => ({
  getRealtimeStreamInstance: () => new streamMarker.S2Marker(),
}));
vi.mock("~/services/realtime/resolveRealtimeStreamClient.server", () => ({
  resolveRealtimeStreamClient: async () => ({
    streamRun: async () => new Response("marker:streamRun", { status: 200 }),
  }),
}));

// Session resolution (peripheral): return a marker session so the run↔session linkage check is
// what runs next (and, absent a seeded SessionRun row, yields a DISTINCT 404 body we assert on).
vi.mock("~/services/realtime/sessions.server", () => ({
  resolveSessionByIdOrExternalId: async () => ctx.session,
  resolveSessionWithWriterFallback: async () => ctx.session,
  canonicalSessionAddressingKey: () => "addr_marker",
  isSessionFriendlyIdForm: () => false,
  serializeSession: (s: any) => s,
}));

// Control-plane env resolver used by the plain-action stream route + the streamKey dashboard route.
vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", () => ({
  controlPlaneResolver: {
    resolveAuthenticatedEnv: async () => ctx.environment,
  },
}));

// Run engine + waitpoint caches for the .wait() routes (peripheral).
vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    createManualWaitpoint: async () => ({ waitpoint: { id: "waitpoint_marker" }, isCached: false }),
    completeWaitpoint: async () => ({}),
  },
}));
vi.mock("~/services/inputStreamWaitpointCache.server", () => ({
  getInputStreamWaitpoint: async () => null,
  setInputStreamWaitpoint: async () => undefined,
  deleteInputStreamWaitpoint: async () => undefined,
}));
vi.mock("~/services/sessionStreamWaitpointCache.server", () => ({
  addSessionStreamWaitpoint: async () => undefined,
  removeSessionStreamWaitpoint: async () => undefined,
}));
vi.mock("~/models/waitpointTag.server", () => ({
  createWaitpointTag: async () => ({}),
  MAX_TAGS_PER_WAITPOINT: 10,
}));

vi.mock("~/services/httpAsyncStorage.server", () => ({
  getRequestAbortSignal: () => undefined,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";

// The REAL exported callers under guard.
import { loader as realtimeRunLoader } from "~/routes/realtime.v1.runs.$runId";
import { loader as streamStreamIdLoader } from "~/routes/realtime.v1.streams.$runId.$streamId";
import {
  action as streamTargetAction,
  loader as streamTargetLoader,
} from "~/routes/realtime.v1.streams.$runId.$target.$streamId";
import { action as streamTargetAppendAction } from "~/routes/realtime.v1.streams.$runId.$target.$streamId.append";
import {
  action as streamInputAction,
  loader as streamInputLoader,
} from "~/routes/realtime.v1.streams.$runId.input.$streamId";
import { action as inputStreamsWaitAction } from "~/routes/api.v1.runs.$runFriendlyId.input-streams.wait";
import { action as sessionStreamsWaitAction } from "~/routes/api.v1.runs.$runFriendlyId.session-streams.wait";
import { loader as dashSessionIoLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.realtime.v1.sessions.$sessionId.$io";
import { loader as dashStreamLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.realtime.v1.streams.$runId.$streamId";
import { loader as dashInputStreamLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.realtime.v1.streams.$runId.input.$streamId";
import { loader as dashStreamKeyLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.streams.$streamKey/route";

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
  // The streamKey dashboard route queries `$replica.project` with a member filter directly (not the
  // mocked findProjectBySlug), so seed a real user + org membership the resolved userId matches.
  const userId = `user_${suffix}`;
  await prisma.user.create({
    data: { id: userId, email: `guard-${suffix}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  await prisma.orgMember.create({
    data: { userId, organizationId: organization.id, role: "ADMIN" },
  });
  return { organization, project, environment, userId };
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
      status: "EXECUTING",
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
      executionStatus: "EXECUTING",
      description: "Run is executing",
      runStatus: "EXECUTING",
      environmentId: p.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      projectId: p.projectId,
      organizationId: p.organizationId,
    },
  };
}

// Seed a live run on the PRIMARY only, freeze the replica, and wire the module singletons.
async function setupLiveRunWithFrozenReplica(prisma: PrismaClient) {
  const suffix = `rt_${seq++}`;
  const seed = await seedTenant(prisma, suffix);
  const runId = `run_${suffix}_${"a".repeat(16)}`;
  const friendlyId = `run_${suffix}`;

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
  primaryHolder.client = prisma;
  replicaHolder.client = replica.client;

  ctx.environment = {
    id: seed.environment.id,
    type: "DEVELOPMENT",
    slug: "dev",
    apiKey: seed.environment.apiKey,
    organizationId: seed.organization.id,
    projectId: seed.project.id,
    organization: { id: seed.organization.id, slug: seed.organization.slug, featureFlags: {} },
    project: {
      id: seed.project.id,
      slug: seed.project.slug,
      externalRef: seed.project.externalRef,
    },
  };
  ctx.project = { id: seed.project.id, slug: seed.project.slug };
  ctx.session = { id: "session_marker", friendlyId: "session_marker", externalId: null };
  ctx.userId = seed.userId;

  return { seed, runId, friendlyId, replica };
}

// Normalize: some dashboard loaders THROW a Response on 404, others RETURN it.
async function invoke(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

// The API-builder enforces `maxContentLength` by REQUIRING a content-length header (missing → 413
// before the handler). Set it so the run read under test is actually reached.
function jsonPost(url: string, body: unknown) {
  const payload = JSON.stringify(body);
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(payload)),
    },
    body: payload,
  });
}

function rawPost(url: string, body: string) {
  return new Request(url, {
    method: "POST",
    headers: { "content-length": String(Buffer.byteLength(body)) },
    body,
  });
}

describe("realtime-stream routes under replica lag", () => {
  // 1. realtime.v1.runs.$runId loader (createLoaderApiRoute findResource) — SDK subscribeToRun.
  heteroPostgresTest(
    "realtime run loader resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          realtimeRunLoader({
            request: new Request(`http://localhost/realtime/v1/runs/${friendlyId}`),
            params: { runId: friendlyId },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      // findResource re-reads the primary → run found → handler reaches the stream client marker.
      expect(res.status).toBe(200);
      expect(await res.clone().text()).toBe("marker:streamRun");
    }
  );

  // 2. realtime.v1.streams.$streamId loader (createLoaderApiRoute findResource) — SSE subscribe.
  heteroPostgresTest(
    "realtime stream loader resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          streamStreamIdLoader({
            request: new Request(`http://localhost/realtime/v1/streams/${friendlyId}/s1`),
            params: { runId: friendlyId, streamId: "s1" },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(200);
      expect(await res.clone().text()).toBe("marker:streamResponse");
    }
  );

  // 4. realtime.v1.streams.$target.$streamId action (createActionApiRoute).
  heteroPostgresTest(
    "realtime stream-target action resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          streamTargetAction({
            request: new Request(`http://localhost/realtime/v1/streams/${friendlyId}/self/s1`, {
              method: "POST",
              body: "chunk-data",
            }),
            params: { runId: friendlyId, target: "self", streamId: "s1" },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(200);
      expect(await res.clone().text()).toBe("marker:ingestData");
    }
  );

  // 5. realtime.v1.streams.$target.$streamId loader (createLoaderApiRoute findResource, HEAD).
  heteroPostgresTest(
    "realtime stream-target loader resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          streamTargetLoader({
            request: new Request(`http://localhost/realtime/v1/streams/${friendlyId}/self/s1`, {
              method: "HEAD",
            }),
            params: { runId: friendlyId, target: "self", streamId: "s1" },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      // Run found → handler reaches the HEAD getLastChunkIndex path (200 + X-Last-Chunk-Index).
      expect(res.status).toBe(200);
      expect(res.headers.get("X-Last-Chunk-Index")).toBe("0");
    }
  );

  // 6. realtime.v1.streams.$target.$streamId.append action (createActionApiRoute).
  heteroPostgresTest(
    "realtime stream-target append action resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          streamTargetAppendAction({
            request: rawPost(
              `http://localhost/realtime/v1/streams/${friendlyId}/self/s1/append`,
              "part-data"
            ),
            params: { runId: friendlyId, target: "self", streamId: "s1" },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      // The first (replica) run read is recovered via the primary re-read → the second read (already on
      // primary) + appendPart marker → {ok:true} 200.
      expect(res.status).toBe(200);
      expect(await res.clone().json()).toEqual({ ok: true });
    }
  );

  // 7. realtime.v1.streams.input.$streamId action (createActionApiRoute, .send()).
  heteroPostgresTest(
    "realtime input-stream action resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          streamInputAction({
            request: jsonPost(`http://localhost/realtime/v1/streams/${friendlyId}/input/s1`, {
              data: { hello: "world" },
            }),
            params: { runId: friendlyId, streamId: "s1" },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      // Run found → appendPart marker → {ok:true}.
      expect(res.status).toBe(200);
      expect(await res.clone().json()).toEqual({ ok: true });
    }
  );

  // 8. realtime.v1.streams.input.$streamId loader (createLoaderApiRoute findResource, SSE tail).
  heteroPostgresTest(
    "realtime input-stream loader resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          streamInputLoader({
            request: new Request(`http://localhost/realtime/v1/streams/${friendlyId}/input/s1`),
            params: { runId: friendlyId, streamId: "s1" },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(200);
      expect(await res.clone().text()).toBe("marker:streamResponse");
    }
  );

  // 9. api.v1 input-streams.wait action (createActionApiRoute, .wait()).
  heteroPostgresTest(
    "input-streams wait action resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          inputStreamsWaitAction({
            request: jsonPost(`http://localhost/api/v1/runs/${friendlyId}/input-streams/wait`, {
              streamId: "s1",
            }),
            params: { runFriendlyId: friendlyId },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      // Run found → createManualWaitpoint marker → waitpoint json.
      expect(res.status).toBe(200);
      expect(await res.clone().json()).toMatchObject({ isCached: false });
    }
  );

  // 10. api.v1 session-streams.wait action (createActionApiRoute, .wait()).
  heteroPostgresTest(
    "session-streams wait action resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          sessionStreamsWaitAction({
            request: jsonPost(`http://localhost/api/v1/runs/${friendlyId}/session-streams/wait`, {
              session: "session_marker",
              io: "out",
            }),
            params: { runFriendlyId: friendlyId },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      // Run found → createManualWaitpoint marker → waitpoint json.
      expect(res.status).toBe(200);
      expect(await res.clone().json()).toMatchObject({ isCached: false });
    }
  );

  // 11. dashboard sessions.$sessionId.$io loader.
  heteroPostgresTest(
    "dashboard session-io loader resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          dashSessionIoLoader({
            request: new Request(
              `http://localhost/resources/.../runs/${friendlyId}/realtime/v1/sessions/session_marker/out`
            ),
            params: {
              organizationSlug: ctx.environment.organization.slug,
              projectParam: ctx.project.slug,
              envParam: "dev",
              runParam: friendlyId,
              sessionId: "session_marker",
              io: "out",
            },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      const body = await res.clone().text();
      // Run read recovered via the primary re-read → past the run 404 → the next gate (run↔session
      // linkage, no seeded SessionRun) returns "Session not found for run". Asserting on body text pins
      // this to the run-read decision specifically.
      expect(body).not.toContain("Run not found");
      expect(body).toContain("Session not found for run");
    }
  );

  // 12. dashboard streams.$streamId loader.
  heteroPostgresTest(
    "dashboard stream loader resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          dashStreamLoader({
            request: new Request(`http://localhost/resources/.../streams/${friendlyId}/s1`),
            params: {
              organizationSlug: ctx.environment.organization.slug,
              projectParam: ctx.project.slug,
              envParam: "dev",
              runParam: friendlyId,
              runId: friendlyId,
              streamId: "s1",
            },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(200);
      expect(await res.clone().text()).toBe("marker:streamResponse");
    }
  );

  // 13. dashboard streams.input.$streamId loader.
  heteroPostgresTest(
    "dashboard input-stream loader resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          dashInputStreamLoader({
            request: new Request(`http://localhost/resources/.../streams/${friendlyId}/input/s1`),
            params: {
              organizationSlug: ctx.environment.organization.slug,
              projectParam: ctx.project.slug,
              envParam: "dev",
              runParam: friendlyId,
              runId: friendlyId,
              streamId: "s1",
            },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      expect(res.status).toBe(200);
      expect(await res.clone().text()).toBe("marker:streamResponse");
    }
  );

  // 14. dashboard streams.$streamKey loader (CLIENT-LESS findRun → replica).
  heteroPostgresTest(
    "dashboard stream-key loader resolves a live run under replica lag",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const { friendlyId, replica } = await setupLiveRunWithFrozenReplica(prisma);

      const res = await invoke(
        () =>
          dashStreamKeyLoader({
            request: new Request(
              `http://localhost/resources/.../streams/${friendlyId}/streams/my-stream`
            ),
            params: {
              organizationSlug: ctx.environment.organization.slug,
              projectParam: ctx.project.slug,
              envParam: "dev",
              runParam: friendlyId,
              streamKey: "my-stream",
            },
            context: {} as never,
          }) as Promise<Response>
      );

      expect(replica.wasHit("taskRun")).toBe(true);
      // The client-less findRun (replica) is recovered via findRunOnPrimary → env resolves (slug
      // matches) → streamResponse marker.
      expect(res.status).toBe(200);
      expect(await res.clone().text()).toBe("marker:streamResponse");
    }
  );
});
