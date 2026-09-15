// Replica-lag proof for seven run-detail PRESENTER reads. Imports and drives the REAL exported presenter
// method / SSE loader that contains each read against a real Postgres (prisma14) whose run-store replica
// is frozen by the shared laggingReplica primitive (taskRun "missing"). Only orthogonal deps are stubbed
// (auth/session, presign, the mollifier buffer/read-fallback, the event repository); the run-store read
// path is the genuine article — a single PostgresRunStore wired as the webapp's single-DB runStore
// singleton (writer = prisma14, replica = frozen). Each case asserts the REAL caller's observable output
// under lag and separately confirms the run is live on the primary, so every miss is purely replica lag.
//
// Every read is a read-only dashboard/API GET whose stale/absent value is a documented fallback
// (buffer / typed-error / retryable-404) or a cosmetic omission that self-heals on the next poll once
// the replica catches up — none drives a mutation, a wrong terminal state, or a non-self-healing
// failure. Each case's per-test comment names the tolerating mechanism.

import { heteroPostgresTest, laggingReplica } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { PostgresRunStore } from "@internal/run-store";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// ---- Holders wired per-test before each real-caller invocation. -----------------------------------
// dbHolder.$replica  -> the BRANDED frozen replica (taskRun reads miss; every other model forwards to
//                       the real container). dbHolder.prisma -> the real writer (prisma14).
// storeHolder.store  -> the single PostgresRunStore the mocked `runStore` singleton forwards to.
// bufferHolder.result-> the mollifier read-fallback result (null = buffer miss, the realistic double-miss).
// bufferHolder.calls -> counts findRunByIdWithMollifierFallback invocations (proves the buffer fallback
//                       path actually ran for read 1, not merely that null happened).
// sessionHolder.userId -> the id requireUserId resolves to (read 4).
// eventRepoHolder.repo -> the event repository getEventRepositoryForStore returns (read 7).
const dbHolder = vi.hoisted(() => ({ prisma: null as any, $replica: null as any }));
const storeHolder = vi.hoisted(() => ({ store: undefined as any }));
const bufferHolder = vi.hoisted(() => ({ result: null as any, calls: 0 }));
const sessionHolder = vi.hoisted(() => ({ userId: "user_presenters_guard" }));
const eventRepoHolder = vi.hoisted(() => ({ repo: undefined as any }));

// ~/db.server: redirect the module-level handles to the real test clients. NOT a DB mock — reads hit a
// real Postgres container; this only chooses which real client each module resolves. $replica is the
// frozen replica; the run-ops split handles are inert (single-DB webapp topology).
vi.mock("~/db.server", () => ({
  get prisma() {
    return dbHolder.prisma;
  },
  get $replica() {
    return dbHolder.$replica;
  },
  runOpsLegacyReplica: undefined,
  runOpsNewReplica: undefined,
  runOpsSplitReadEnabled: false,
}));

// The ONE wiring boundary: inject the real single-DB store the presenters read through. A stable getter
// keeps the named import binding constant while returning the per-test store.
vi.mock("~/v3/runStore.server", () => ({
  get runStore() {
    return storeHolder.store;
  },
}));

// Presign is never exercised (payloads are inline JSON on the null path); inert stub keeps the import light.
vi.mock("~/v3/objectStore.server", () => ({
  generatePresignedUrl: vi.fn(async () => ({ success: false, error: "not-used" })),
}));

// The mollifier read-fallback is a downstream service ORTHOGONAL to the run-store read under test. It
// returns bufferHolder.result (null = buffer miss) and counts calls so read 1 can prove the fallback ran.
vi.mock("~/v3/mollifier/readFallback.server", () => ({
  findRunByIdWithMollifierFallback: vi.fn(async () => {
    bufferHolder.calls++;
    return bufferHolder.result;
  }),
}));

// The mollifier buffer (read 4) — disabled so the stream loader's fallback is a clean miss and the only
// thing that could resolve a traceId is the run-store read (frozen -> null -> 404).
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({
  getMollifierBuffer: () => null,
}));

// Dashboard session auth (read 4) — resolves a fixed user id. Orthogonal to the run read.
vi.mock("~/services/session.server", () => ({
  requireUserId: vi.fn(async () => sessionHolder.userId),
  getUserId: vi.fn(async () => sessionHolder.userId),
  requireUser: vi.fn(async () => ({ id: sessionHolder.userId })),
  getUser: vi.fn(async () => ({ id: sessionHolder.userId })),
}));

// The event repository (read 7) — a downstream store, not the run read. getSpan returns eventRepoHolder.repo's
// span so #getSpan proceeds to the run-store findRuns({parentSpanId}) read under test.
vi.mock("~/v3/eventRepository/index.server", () => ({
  getEventRepositoryForStore: vi.fn(async () => eventRepoHolder.repo),
}));

// The REAL exported callers under proof.
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import { ApiRunResultPresenter } from "~/presenters/v3/ApiRunResultPresenter.server";
import { RunPresenter, RunNotInPgError } from "~/presenters/v3/RunPresenter.server";
import { RunStreamPresenter } from "~/presenters/v3/RunStreamPresenter.server";
import { PlaygroundPresenter } from "~/presenters/v3/PlaygroundPresenter.server";
import { SpanPresenter } from "~/presenters/v3/SpanPresenter.server";

let seq = 0;

type Seed = {
  organizationId: string;
  projectId: string;
  projectSlug: string;
  environmentId: string;
  environmentSlug: string;
};

async function seedTenant(prisma: PrismaClient, suffix: string): Promise<Seed> {
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
  await prisma.user.create({
    data: {
      id: sessionHolder.userId,
      email: `guard-${suffix}@example.com`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
  await prisma.orgMember.create({
    data: { userId: sessionHolder.userId, organizationId: organization.id, role: "ADMIN" },
  });
  return {
    organizationId: organization.id,
    projectId: project.id,
    projectSlug: project.slug,
    environmentId: environment.id,
    environmentSlug: environment.slug,
  };
}

async function seedRun(
  prisma: PrismaClient,
  seed: Seed,
  opts: {
    id: string;
    friendlyId: string;
    status?: string;
    spanId?: string;
    parentSpanId?: string;
  }
) {
  await prisma.taskRun.create({
    data: {
      id: opts.id,
      engine: "V2",
      status: (opts.status ?? "EXECUTING") as never,
      friendlyId: opts.friendlyId,
      runtimeEnvironmentId: seed.environmentId,
      environmentType: "DEVELOPMENT",
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      taskIdentifier: "my-task",
      payload: "{}",
      payloadType: "application/json",
      traceContext: {},
      traceId: `trace_${opts.id}`,
      spanId: opts.spanId ?? `span_${opts.id}`,
      ...(opts.parentSpanId !== undefined ? { parentSpanId: opts.parentSpanId } : {}),
      queue: "task/my-task",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
    },
  });
}

// Wire the per-test holders: the branded frozen replica over `prisma`, and the single PostgresRunStore
// (writer = prisma, replica = frozen) the mocked runStore singleton forwards to. Returns the frozen
// handle so a test can assert wasHit("taskRun").
function wireFrozenStore(prisma: PrismaClient) {
  const frozen = laggingReplica(prisma, [{ model: "taskRun", mode: "missing" }]);
  const store = new PostgresRunStore({ prisma, readOnlyPrisma: frozen.client as never });
  dbHolder.prisma = prisma;
  dbHolder.$replica = frozen.client;
  storeHolder.store = store;
  bufferHolder.result = null;
  bufferHolder.calls = 0;
  return frozen;
}

describe("run-detail presenter reads against a frozen run-store replica", () => {
  // ApiRetrieveRunPresenter findRun (+$replica) — public GET /api/v3/runs/:runId. Drive the REAL static
  // findRun. Under lag the replica misses and the buffer fallback (findRunByIdWithMollifierFallback)
  // fires (proven by call count), buffer misses too, so the caller returns null. The retrieve route maps
  // null to a 404 carrying `x-should-retry: true`, so the SDK retrieve/poll loop re-fetches and the next
  // poll (replica caught up) succeeds. Self-healing; read-only.
  heteroPostgresTest(
    "ApiRetrieveRunPresenter.findRun returns null for a live run absent on the replica (retryable-404 contract)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `retrieve_${seq++}`;
      const seed = await seedTenant(prisma, suffix);
      const runId = `run_id_${suffix}`;
      const friendlyId = `run_${suffix}`;
      await seedRun(prisma, seed, { id: runId, friendlyId, status: "COMPLETED_SUCCESSFULLY" });

      const frozen = wireFrozenStore(prisma);

      const env = { id: seed.environmentId, organizationId: seed.organizationId } as any;
      const result = await ApiRetrieveRunPresenter.findRun(friendlyId, env);

      // The frozen replica WAS consulted (the read-your-writes window is really exercised)...
      expect(frozen.wasHit("taskRun")).toBe(true);
      // ...the presenter's documented buffer fallback FIRED (not merely that null happened)...
      expect(bufferHolder.calls).toBe(1);
      // ...and the observable caller output is null (retrieve route -> retryable 404).
      expect(result).toBeNull();

      // Primary contrast: the run is genuinely live — the miss is purely replica lag.
      const onPrimary = await prisma.taskRun.findFirst({
        where: { friendlyId },
        select: { id: true },
      });
      expect(onPrimary?.id).toBe(runId);
    }
  );

  // ApiRunResultPresenter findRun (no client) — GET /api/v1/runs/:runId/result poll (SDK waitForRun
  // result). Drive the REAL call(); the store is injected via the presenter's own constructor seam (4th
  // arg). Under lag the replica misses -> null -> the presenter returns undefined, the poll's "not
  // finished yet" signal — the SDK result-poll loop retries and succeeds once the replica catches up.
  // Read-only.
  heteroPostgresTest(
    "ApiRunResultPresenter.call returns undefined for a live run absent on the replica (poll retries)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `result_${seq++}`;
      const seed = await seedTenant(prisma, suffix);
      const runId = `run_id_${suffix}`;
      const friendlyId = `run_${suffix}`;
      await seedRun(prisma, seed, { id: runId, friendlyId, status: "COMPLETED_SUCCESSFULLY" });

      const frozen = wireFrozenStore(prisma);

      // Construct exactly as the route does, but inject the real frozen store through the ctor seam.
      const presenter = new ApiRunResultPresenter(
        prisma,
        frozen.client as any,
        undefined,
        storeHolder.store
      );
      // call() wraps in traceWithEnv, which reads env slug/org/project attributes.
      const env = {
        id: seed.environmentId,
        type: "DEVELOPMENT",
        slug: seed.environmentSlug,
        organizationId: seed.organizationId,
        organization: { id: seed.organizationId, slug: seed.projectSlug, title: "Org" },
        projectId: seed.projectId,
        project: { id: seed.projectId, name: "Project" },
      } as any;
      const result = await presenter.call(friendlyId, env);

      expect(frozen.wasHit("taskRun")).toBe(true);
      expect(result).toBeUndefined();

      const onPrimary = await prisma.taskRun.findFirst({
        where: { friendlyId },
        select: { id: true },
      });
      expect(onPrimary?.id).toBe(runId);
    }
  );

  // RunPresenter findRun (no client) — dashboard run-detail page loader. Drive the REAL call(). Under
  // lag the replica misses -> null -> the presenter throws the typed RunNotInPgError, the route's signal
  // to fall back to the synthesised mollifier-buffer view (and off the noisy Prisma error path); the
  // page self-heals on the next poll. Read-only.
  heteroPostgresTest(
    "RunPresenter.call throws RunNotInPgError for a live run absent on the replica (route buffer view)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `detail_${seq++}`;
      const seed = await seedTenant(prisma, suffix);
      const runId = `run_id_${suffix}`;
      const friendlyId = `run_${suffix}`;
      await seedRun(prisma, seed, { id: runId, friendlyId });

      const frozen = wireFrozenStore(prisma);

      const presenter = new RunPresenter(prisma);
      const call = presenter.call({
        userId: sessionHolder.userId,
        projectSlug: seed.projectSlug,
        environmentSlug: seed.environmentSlug,
        runFriendlyId: friendlyId,
        showDeletedLogs: false,
        showDebug: false,
      });

      await expect(call).rejects.toBeInstanceOf(RunNotInPgError);
      expect(frozen.wasHit("taskRun")).toBe(true);

      const onPrimary = await prisma.taskRun.findFirst({
        where: { friendlyId },
        select: { id: true },
      });
      expect(onPrimary?.id).toBe(runId);
    }
  );

  // RunStreamPresenter findRun (no client) — run-detail SSE trace-stream loader. Drive the REAL loader
  // from createLoader(). Under lag the replica misses -> run null -> not authorized -> traceId null ->
  // buffer disabled -> the handler throws Response(404), which createSSELoader rethrows. 404 is the
  // SSE-reconnect contract: the dashboard reconnects and the next connection (replica caught up)
  // attaches.
  heteroPostgresTest(
    "RunStreamPresenter loader throws Response 404 for a live run absent on the replica (SSE reconnect)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `stream_${seq++}`;
      const seed = await seedTenant(prisma, suffix);
      const runId = `run_id_${suffix}`;
      const friendlyId = `run_${suffix}`;
      await seedRun(prisma, seed, { id: runId, friendlyId });

      const frozen = wireFrozenStore(prisma);

      const loader = new RunStreamPresenter(prisma).createLoader();
      const request = new Request(`http://localhost/resources/runs/${friendlyId}/stream`);

      let thrown: unknown;
      try {
        await loader({ request, params: { runParam: friendlyId } } as any);
      } catch (e) {
        thrown = e;
      }

      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(404);
      expect(frozen.wasHit("taskRun")).toBe(true);

      const onPrimary = await prisma.taskRun.findFirst({
        where: { friendlyId },
        select: { id: true },
      });
      expect(onPrimary?.id).toBe(runId);
    }
  );

  // PlaygroundPresenter findRuns (no client) — agent-playground conversation list. Drive the REAL
  // getRecentConversations. The conversation row is read off $replica (playgroundConversation not
  // frozen), then each backing run's scalars via a client-less findRuns over the id set (frozen -> []).
  // The missing run is absent from runsById, so the conversation renders with runFriendlyId=null /
  // runStatus=null / isActive=false — a cosmetic "status unknown" on one row that self-heals next load.
  // The row still renders.
  heteroPostgresTest(
    "PlaygroundPresenter.getRecentConversations renders the row with null run fields when the run is absent on the replica",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `playground_${seq++}`;
      const seed = await seedTenant(prisma, suffix);
      const runId = `run_id_${suffix}`;
      const friendlyId = `run_${suffix}`;
      await seedRun(prisma, seed, { id: runId, friendlyId, status: "EXECUTING" });

      await prisma.playgroundConversation.create({
        data: {
          chatId: `chat_${suffix}`,
          title: "Conversation",
          agentSlug: "my-agent",
          runId,
          projectId: seed.projectId,
          runtimeEnvironmentId: seed.environmentId,
          userId: sessionHolder.userId,
        },
      });

      const frozen = wireFrozenStore(prisma);

      const presenter = new PlaygroundPresenter();
      const conversations = await presenter.getRecentConversations({
        environmentId: seed.environmentId,
        agentSlug: "my-agent",
        userId: sessionHolder.userId,
      });

      expect(frozen.wasHit("taskRun")).toBe(true);
      // The conversation row IS returned (not dropped)...
      expect(conversations).toHaveLength(1);
      // ...but its backing-run fields self-heal to null because the run missed on the replica.
      expect(conversations[0].chatId).toBe(`chat_${suffix}`);
      expect(conversations[0].runFriendlyId).toBeNull();
      expect(conversations[0].runStatus).toBeNull();
      expect(conversations[0].isActive).toBe(false);

      const onPrimary = await prisma.taskRun.findFirst({
        where: { id: runId },
        select: { id: true },
      });
      expect(onPrimary?.id).toBe(runId);
    }
  );

  // SpanPresenter findRun (+this._replica) — span-detail (run inspector) panel. Drive the REAL public
  // findRun with the originalRunId branch; it passes the branded this._replica. Under lag the replica
  // misses -> null. The span-detail panel renders its not-found/loading state for this poll and
  // self-heals next tick. Read-only.
  heteroPostgresTest(
    "SpanPresenter.findRun returns null for a live run absent on the replica (span-detail not-found this poll)",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `span_${seq++}`;
      const seed = await seedTenant(prisma, suffix);
      const runId = `run_id_${suffix}`;
      const friendlyId = `run_${suffix}`;
      await seedRun(prisma, seed, { id: runId, friendlyId });

      const frozen = wireFrozenStore(prisma);

      // _prisma = writer, _replica = branded frozen (exactly how the webapp constructs it).
      const presenter = new SpanPresenter(prisma, frozen.client as any);
      const run = await presenter.findRun({
        originalRunId: friendlyId,
        spanId: `span_${runId}`,
        environmentId: seed.environmentId,
      });

      expect(frozen.wasHit("taskRun")).toBe(true);
      expect(run).toBeNull();

      const onPrimary = await prisma.taskRun.findFirst({
        where: { friendlyId },
        select: { id: true },
      });
      expect(onPrimary?.id).toBe(runId);
    }
  );

  // SpanPresenter findRuns {parentSpanId} (+this._replica) — the "triggered runs" list on the
  // span-detail panel. Drive the REAL call() end-to-end: it resolves the parent run on the primary,
  // gets the span from the (stubbed) event repository, then reads the child runs via
  // runStore.findRuns({parentSpanId}, this._replica) — the frozen replica. Under lag the just-triggered
  // child is invisible -> span.triggeredRuns === [] — a cosmetic "one fewer child shown" that self-heals
  // next poll; the child still exists and executes. Read-only.
  heteroPostgresTest(
    "SpanPresenter.call yields empty triggeredRuns when the child run is absent on the replica",
    async ({ prisma14 }) => {
      const prisma = prisma14 as unknown as PrismaClient;
      const suffix = `triggered_${seq++}`;
      const seed = await seedTenant(prisma, suffix);

      const parentRunId = `run_parent_${suffix}`;
      const parentFriendlyId = `run_${suffix}`;
      const spanId = `span_detail_${suffix}`;
      await seedRun(prisma, seed, {
        id: parentRunId,
        friendlyId: parentFriendlyId,
        spanId,
      });

      // The child run whose parentSpanId is the inspected span — the one that should appear in the
      // triggered-runs list but is missing on the frozen replica.
      const childRunId = `run_child_${suffix}`;
      const childFriendlyId = `run_child_fr_${suffix}`;
      await seedRun(prisma, seed, {
        id: childRunId,
        friendlyId: childFriendlyId,
        spanId: `span_child_${suffix}`,
        parentSpanId: spanId,
      });

      const frozen = wireFrozenStore(prisma);

      // Stub the event repository so getSpan yields a minimal "attempt" span; this lets #getSpan proceed
      // to the run-store findRuns({parentSpanId}) read under test without ClickHouse.
      eventRepoHolder.repo = {
        getSpan: async () => ({
          spanId,
          parentId: undefined,
          message: "attempt",
          isError: false,
          isPartial: false,
          isCancelled: false,
          level: "TRACE",
          startTime: new Date(),
          duration: 0,
          events: [],
          style: {},
          properties: {},
          resourceProperties: {},
          entity: { type: "attempt", id: undefined },
          metadata: {},
        }),
        // Not reached on this path (getRun returns undefined before a trace summary is needed).
        getTraceSummary: async () => null,
      };

      const presenter = new SpanPresenter(prisma, frozen.client as any);
      const result = await presenter.call({
        userId: sessionHolder.userId,
        projectSlug: seed.projectSlug,
        envSlug: seed.environmentSlug,
        spanId,
        runFriendlyId: parentFriendlyId,
      });

      expect(frozen.wasHit("taskRun")).toBe(true);
      expect(result?.type).toBe("span");
      // The child triggered by this span is omitted from the list under replica lag.
      expect((result as any).span.triggeredRuns).toEqual([]);

      // Primary contrast: the child genuinely exists with this parentSpanId — the omission is pure lag.
      const childOnPrimary = await prisma.taskRun.findFirst({
        where: { parentSpanId: spanId },
        select: { friendlyId: true },
      });
      expect(childOnPrimary?.friendlyId).toBe(childFriendlyId);
    }
  );
});
