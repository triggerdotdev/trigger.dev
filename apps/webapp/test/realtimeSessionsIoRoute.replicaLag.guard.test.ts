// Property: under a lagging control-plane replica the dashboard Agent-tab SSE subscribe loader still
// resolves a just-created Session / SessionRun and establishes the stream (200), never surfacing a
// "Session not found" / "Session not found for run" 404 for a live subscription. The Session read uses
// a replica-first writer fallback and the run<->session linkage read re-reads the primary on a replica
// miss.
//
// Drives the REAL exported route loader against a real Postgres testcontainer whose control-plane read
// replica is a real lagging replica (the shared laggingReplica primitive); the DB is never mocked. Only
// orthogonal deps are mocked (dashboard auth/session, project/environment slug resolution, the realtime
// stream instance, the request abort signal). Case A freezes Session on the replica; Case B freezes
// SessionRun; wasHit proves the frozen replica was really consulted, so no green is a lucky primary hit.

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// ---- Holders wired into the mocked module singletons before each loader() call. ------------------
// `primaryHolder.client` -> the real container (the writer / owning primary).
// `replicaHolder.client` -> a lagging replica over the SAME container: the frozen model's reads come
//   back empty (row "not replicated yet"); every other model + all writes forward to the real container.
const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const replicaHolder = vi.hoisted(() => ({ client: undefined as any }));

// The user the (mocked) dashboard auth resolves to.
const AUTH = vi.hoisted(() => ({ userId: "user_sessions_io_guard" }));

// Staged fix-orthogonal control-plane resolutions (project + environment slug lookups).
const cpLookups = vi.hoisted(() => ({ project: undefined as any, environment: undefined as any }));

// ~/db.server: point the two proxies the run-store / control-plane singletons read at our holders.
// Never mocks the DB itself — the proxies forward to real testcontainer clients. Run-ops split handles
// are left undefined so runStore.server falls back to the single control-plane store (writer = `prisma`,
// replica = `$replica`) — the exact webapp single-DB topology the read-your-writes hazard lives in.
vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");
  const lazyProxy = (holder: { client: any }, label: string) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (!holder.client) throw new Error(`${label} not set for this test`);
          const value = holder.client[prop];
          // The run-store singleton memoizes each Prisma delegate on first access; re-resolve through
          // the holder so it always routes to the current test's client (mirrors the sibling guards).
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
    // Split-off: leaving these undefined makes runStore.server build the single-DB passthrough store.
    runOpsNewPrismaClient: undefined,
    runOpsNewReplicaClient: undefined,
    runOpsLegacyPrisma: undefined,
    runOpsLegacyReplica: undefined,
    sqlDatabaseSchema: Prisma.sql([`public`]),
  };
});

// Dashboard auth (orthogonal): a fixed user id.
vi.mock("~/services/session.server", () => ({
  getUserId: async () => AUTH.userId,
  requireUserId: async () => AUTH.userId,
}));

// Project / environment slug resolution (orthogonal control-plane auth reads): return what's staged.
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => cpLookups.project,
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => cpLookups.environment,
}));

// Realtime stream backend (orthogonal): make `getRealtimeStreamInstance` return a REAL instance of the
// (mocked) S2RealtimeStreams class so the loader's `instanceof S2RealtimeStreams` gate passes, and its
// `streamResponseFromSessionStream` returns a marker 200 Response — proof the loader reached the stream
// rather than 404'ing on a session/linkage read.
vi.mock("~/services/realtime/s2realtimeStreams.server", () => {
  class S2RealtimeStreams {
    streamResponseFromSessionStream() {
      return new Response("stream-established", {
        status: 200,
        headers: { "x-stream": "established" },
      });
    }
  }
  return { S2RealtimeStreams };
});
vi.mock("~/services/realtime/v1StreamsGlobal.server", async () => {
  const { S2RealtimeStreams } = await import("~/services/realtime/s2realtimeStreams.server");
  return { getRealtimeStreamInstance: () => new (S2RealtimeStreams as any)() };
});

// Request abort signal is sourced from AsyncLocalStorage in prod; not under test.
vi.mock("~/services/httpAsyncStorage.server", () => ({
  getRequestAbortSignal: () => new AbortController().signal,
}));

// The REAL loader under test.
import { loader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.$runParam.realtime.v1.sessions.$sessionId.$io";

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

async function seedSessionRunLinkage(
  prisma: PrismaClient,
  seed: { organization: any; project: any; environment: any },
  suffix: string
) {
  const session = await prisma.session.create({
    data: {
      friendlyId: `session_${suffix}`,
      type: "chat",
      projectId: seed.project.id,
      runtimeEnvironmentId: seed.environment.id,
      environmentType: "DEVELOPMENT",
      organizationId: seed.organization.id,
      taskIdentifier: "agent-task",
      triggerConfig: { basePayload: {} },
    },
  });
  const run = await prisma.taskRun.create({
    data: {
      friendlyId: `run_${suffix}`,
      engine: "V2",
      taskIdentifier: "agent-task",
      payload: "{}",
      payloadType: "application/json",
      traceId: `trace_${suffix}`,
      spanId: `span_${suffix}`,
      queue: "task/agent-task",
      projectId: seed.project.id,
      organizationId: seed.organization.id,
      runtimeEnvironmentId: seed.environment.id,
      runTags: [],
    },
  });
  const sessionRun = await prisma.sessionRun.create({
    data: { sessionId: session.id, runId: run.id, reason: "initial" },
  });
  return { session, run, sessionRun };
}

function subscribeRequest() {
  return new Request(
    "http://localhost/resources/orgs/o/projects/p/env/dev/runs/r/realtime/v1/sessions/s/out"
  );
}

function loaderParams(
  seed: { organization: any; project: any },
  runFriendlyId: string,
  sessionFriendlyId: string
) {
  return {
    organizationSlug: seed.organization.slug,
    projectParam: seed.project.slug,
    envParam: "dev",
    runParam: runFriendlyId,
    sessionId: sessionFriendlyId,
    io: "out",
  };
}

function stageCpLookups(seed: { organization: any; project: any; environment: any }) {
  cpLookups.project = { id: seed.project.id, organizationId: seed.organization.id };
  cpLookups.environment = { id: seed.environment.id, type: "DEVELOPMENT", slug: "dev" };
}

describe("sessions.$sessionId.$io SSE subscribe loader under control-plane replica lag", () => {
  heteroPostgresTest(
    "establishes the stream for a Session not yet replicated via the writer fallback",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `sessguard_a_${seq++}`;

      const seed = await seedTenant(prisma, suffix);
      const { session, run } = await seedSessionRunLinkage(prisma, seed, suffix);
      stageCpLookups(seed);

      // Freeze `Session` on the replica: the just-created row is not visible there, only on the writer.
      const replica = laggingReplica(prisma, [{ model: "session", mode: "missing" }]);
      primaryHolder.client = prisma;
      replicaHolder.client = replica.client;

      const res = (await loader({
        request: subscribeRequest(),
        params: loaderParams(seed, run.friendlyId, session.friendlyId),
        context: {} as never,
      })) as Response;

      // Frozen replica really consulted (not a lucky primary hit); writer fallback then resolved it.
      expect(replica.wasHit("session")).toBe(true);
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-stream")).toBe("established");
      const body = await res.clone().text();
      expect(body).not.toContain("Session not found");
    }
  );

  heteroPostgresTest(
    "establishes the stream for a SessionRun linkage not yet replicated via the primary re-read",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `sessguard_b_${seq++}`;

      const seed = await seedTenant(prisma, suffix);
      const { session, run } = await seedSessionRunLinkage(prisma, seed, suffix);
      stageCpLookups(seed);

      // Freeze `SessionRun` on the replica: the linkage row is missing there, but the Session is present.
      const replica = laggingReplica(prisma, [{ model: "sessionRun", mode: "missing" }]);
      primaryHolder.client = prisma;
      replicaHolder.client = replica.client;

      const res = (await loader({
        request: subscribeRequest(),
        params: loaderParams(seed, run.friendlyId, session.friendlyId),
        context: {} as never,
      })) as Response;

      // Frozen replica really consulted; primary re-read then resolved the linkage.
      expect(replica.wasHit("sessionRun")).toBe(true);
      expect(res.status).not.toBe(404);
      expect(res.status).toBe(200);
      expect(res.headers.get("x-stream")).toBe("established");
      const body = await res.clone().text();
      expect(body).not.toContain("Session not found for run");
    }
  );
});
