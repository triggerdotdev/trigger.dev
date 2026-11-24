// A message appended to a session's `.in` while its run is on the way out is answered by a
// continuation run, whichever way the run ends and however the append interleaves with it.
//
// Drives the real `ensureRunThenAppend` (the append side) and the real run-completion check against
// a real Postgres and a real S2 (s2-lite in a container): the appends, the tail reads, the paged
// `.in` reads are S2's own, and record timestamps are stored and returned by S2. Faked: the run trigger (it writes a real
// TaskRun row, as in the other session run manager suites), the run cancel, the waitpoint cache,
// and the module that picks the S2 client (`v1StreamsGlobal` reads `env.server`, which tests must
// not import), which here hands back the real `S2RealtimeStreams` pointed at s2-lite. The client is
// a thin subclass that only adds test seams: a hook before an append lands, an unreadable `.out`,
// and a read counter. Records a run's SDK would write (a turn-complete with its `.in` cursor, `.in`
// records stored at a chosen time) go in through the same S2 client library the agent runtime uses.

import { postgresTest } from "@internal/testcontainers";
import { createS2Container, type StartedS2Container } from "@internal/testcontainers/webapp";
import { AppendInput, AppendRecord, S2 } from "@s2-dev/streamstore";
import {
  SESSION_IN_EVENT_ID_HEADER,
  TRIGGER_CONTROL_HEADER,
  TRIGGER_CONTROL_SUBTYPE,
} from "@trigger.dev/core/v3";
import { $transaction as realTransaction } from "@trigger.dev/database";
import type { PrismaClient } from "@trigger.dev/database";
import { afterAll, beforeAll, describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const primaryHolder = vi.hoisted(() => ({ client: undefined as any }));
const storeHolder = vi.hoisted(() => ({ store: undefined as any }));

const s2 = vi.hoisted(() => ({
  /** Where s2-lite listens (its API root, `/v1` included); set once the container is up. */
  endpoint: "",
  /** The same server without `/v1`, which the S2 client library appends itself. */
  host: "",
  basin: "",
  /** Runs inside `appendPartToSessionStream`, before the record lands. */
  beforeAppendLands: undefined as undefined | ((io: string) => Promise<void>),
  /** Runs inside `appendPartToSessionStream`, after the record landed and before it returns. */
  afterAppendLands: undefined as undefined | ((io: string) => Promise<void>),
  /** `.out` cannot be read, as when S2 does not answer. */
  outUnreadable: false,
  /** How many times `.in`/`.out` records were read (the bounded scan's cost). */
  readCalls: 0,
  /** The `.in` tail read throws, as when S2 does not answer. */
  inTailThrows: false,
}));

// Every stream name is `${STREAM_PREFIX}/sessions/<key>/<io>`, the shape production uses.
const STREAM_PREFIX = "org/test";

vi.mock("~/services/realtime/v1StreamsGlobal.server", async () => {
  const { S2RealtimeStreams } = await import("~/services/realtime/s2realtimeStreams.server");

  class TestStreams extends S2RealtimeStreams {
    override async appendPartToSessionStream(
      ...args: Parameters<InstanceType<typeof S2RealtimeStreams>["appendPartToSessionStream"]>
    ) {
      await s2.beforeAppendLands?.(args[3]);
      const seq = await super.appendPartToSessionStream(...args);
      await s2.afterAppendLands?.(args[3]);
      return seq;
    }

    override async peekSessionOutTail(
      ...args: Parameters<InstanceType<typeof S2RealtimeStreams>["peekSessionOutTail"]>
    ) {
      if (s2.outUnreadable) return { kind: "unknown" as const };
      return super.peekSessionOutTail(...args);
    }

    override async readSessionInTailSeq(
      ...args: Parameters<InstanceType<typeof S2RealtimeStreams>["readSessionInTailSeq"]>
    ) {
      if (s2.inTailThrows) throw new Error("S2 did not answer");
      return super.readSessionInTailSeq(...args);
    }

    override async readSessionStreamRecords(
      ...args: Parameters<InstanceType<typeof S2RealtimeStreams>["readSessionStreamRecords"]>
    ) {
      s2.readCalls++;
      return super.readSessionStreamRecords(...args);
    }
  }

  return {
    determineRealtimeStreamsVersion: () => "v2",
    getRealtimeStreamInstance: () =>
      new TestStreams({
        endpoint: s2.endpoint,
        basin: s2.basin,
        accessToken: "unused",
        skipAccessTokens: true,
        streamPrefix: STREAM_PREFIX,
        s2WaitSeconds: 0,
      }),
  };
});

vi.mock("~/services/sessionStreamWaitpointCache.server", () => ({
  listSessionStreamWaitpoints: async () => [],
  drainSessionStreamWaitpoints: async () => [],
  addSessionStreamWaitpoint: async () => undefined,
  claimSessionStreamPart: async () => true,
  releaseSessionStreamPart: async () => undefined,
}));

const triggerState = vi.hoisted(() => ({
  calls: [] as Array<{ body: any; options: any }>,
  seed: undefined as undefined | { organizationId: string; projectId: string; envId: string },
  next: 0,
}));

vi.mock("~/db.server", () => {
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
    $replica: lazyProxy(primaryHolder, "primaryHolder.client"),
    $transaction: (_client: unknown, nameOrFn: unknown, fnOrOptions?: unknown, options?: unknown) =>
      realTransaction(
        primaryHolder.client,
        (typeof nameOrFn === "function" ? nameOrFn : fnOrOptions) as any,
        () => {},
        (typeof nameOrFn === "function" ? fnOrOptions : options) as any
      ),
  };
});

vi.mock("~/v3/runStore.server", () => ({
  runStore: new Proxy(
    {},
    {
      get(_t, prop) {
        const store = storeHolder.store as Record<string | symbol, unknown>;
        if (!store) throw new Error("test bug: storeHolder.store not set before caller ran");
        const value = store[prop];
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(store)
          : value;
      },
    }
  ),
}));

vi.mock("~/services/logger.server", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// A real run row per trigger, so the claim and the next probe read genuine state.
vi.mock("~/v3/services/triggerTask.server", () => ({
  TriggerTaskService: class {
    async call(taskIdentifier: string, _environment: any, body: any, options?: any) {
      triggerState.calls.push({ body, options });
      const n = triggerState.next++;
      const seed = triggerState.seed!;
      const created = await storeHolder.store.createRun(
        newRunInput(seed, `trig${n}`.padEnd(24, "t"), `run_trig_${n}`, "PENDING")
      );
      return { run: { id: created.id, friendlyId: `run_trig_${n}`, status: "PENDING" } };
    }
  },
}));

const cancelState = vi.hoisted(() => ({ runIds: [] as string[] }));

vi.mock("~/v3/services/cancelTaskRun.server", () => ({
  CancelTaskRunService: class {
    async call(run: { id: string }) {
      cancelState.runIds.push(run.id);
      await primaryHolder.client.taskRun.update({
        where: { id: run.id },
        data: { status: "CANCELED", completedAt: new Date() },
      });
    }
  },
}));

vi.mock("~/services/externalDeploymentCacheInstance.server", () => ({
  externalDeploymentCacheInstance: {},
}));

vi.mock("~/v3/services/resolveExternalDeployment.server", () => ({
  resolveExternalDeployment: async () => ({ outcome: "park" }),
}));

import {
  S2RealtimeStreams,
  type SessionOutTail,
} from "~/services/realtime/s2realtimeStreams.server";
import { PostgresRunStore } from "@internal/run-store";
import type { CreateRunInput } from "@internal/run-store";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ensureRunThenAppend } from "~/services/realtime/sessionChannelAppend.server";
import { ensureRunForSession, swapSessionRun } from "~/services/realtime/sessionRunManager.server";
import { deliverPartToSession } from "~/v3/webhookSessionDelivery.server";
import {
  continueSessionIfInputUnread,
  runSessionRunCompletionJob,
  SESSION_RUN_COMPLETION_MAX_ATTEMPTS,
  SessionRunCompletionPayloadSchema,
} from "~/services/realtime/sessionRunCompletion.server";

const CHAT_ID = "chat-1";
const RUN_AGE_MS = 60_000;

let counter = 0;

function newRunInput(
  seed: { organizationId: string; projectId: string; envId: string },
  runId: string,
  friendlyId: string,
  status: "PENDING" | "EXECUTING",
  createdAt: Date = new Date()
): CreateRunInput {
  return {
    data: {
      id: runId,
      engine: "V2",
      status,
      friendlyId,
      runtimeEnvironmentId: seed.envId,
      environmentType: "PRODUCTION",
      organizationId: seed.organizationId,
      projectId: seed.projectId,
      taskIdentifier: "my-chat",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "trace_1",
      spanId: "span_1",
      runTags: [],
      queue: "task/my-chat",
      isTest: false,
      taskEventStore: "taskEvent",
      depth: 0,
      createdAt,
    },
    snapshot: {
      engine: "V2",
      executionStatus: status === "EXECUTING" ? "EXECUTING_WITH_WAITPOINTS" : "QUEUED",
      description: "test",
      runStatus: status,
      environmentId: seed.envId,
      environmentType: "PRODUCTION",
      projectId: seed.projectId,
      organizationId: seed.organizationId,
    },
  };
}

async function setup(prisma: PrismaClient) {
  const suffix = `cont_${counter++}`;
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
  const dbEnvironment = await prisma.runtimeEnvironment.create({
    data: {
      type: "PRODUCTION",
      slug: "prod",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${suffix}`,
      pkApiKey: `pk_prod_${suffix}`,
      shortcode: `short_${suffix}`,
    },
  });
  const seed = { organizationId: organization.id, projectId: project.id, envId: dbEnvironment.id };
  const environment = {
    id: dbEnvironment.id,
    type: "PRODUCTION",
    organization: { streamBasinName: null, featureFlags: {} },
  } as unknown as AuthenticatedEnvironment;

  primaryHolder.client = prisma;
  storeHolder.store = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  triggerState.calls.length = 0;
  triggerState.seed = seed;
  cancelState.runIds.length = 0;
  s2.beforeAppendLands = undefined;
  s2.afterAppendLands = undefined;
  s2.outUnreadable = false;
  s2.readCalls = 0;
  s2.inTailThrows = false;

  // A stream key of its own, so tests that share the s2-lite container never see each other's records.
  return { suffix, seed, environment, key: `chat-${suffix}` };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

/** A session whose current run is live: created a minute ago and still executing. */
async function sessionWithLiveRun(prisma: PrismaClient, ctx: Ctx, closed = false) {
  const runCreatedAt = new Date(Date.now() - RUN_AGE_MS);
  const runId = `live${ctx.suffix}`.padEnd(24, "x");
  const friendlyId = `run_live_${ctx.suffix}`;
  await (storeHolder.store as PostgresRunStore).createRun(
    newRunInput(ctx.seed, runId, friendlyId, "EXECUTING", runCreatedAt)
  );
  const session = await prisma.session.create({
    data: {
      friendlyId: `session_${ctx.suffix}`,
      externalId: ctx.key,
      type: "chat.agent",
      projectId: ctx.seed.projectId,
      runtimeEnvironmentId: ctx.seed.envId,
      environmentType: "PRODUCTION",
      organizationId: ctx.seed.organizationId,
      taskIdentifier: "my-chat",
      triggerConfig: { basePayload: {} } as never,
      currentRunId: runId,
      currentRunVersion: 0,
      closedAt: closed ? new Date() : null,
    },
  });
  return { session, run: { id: runId, friendlyId, createdAt: runCreatedAt } };
}

/** Appends records to one of the session's channels, as S2 stores them at `timestamp`. */
function sessionStream(ctx: Ctx, io: "in" | "out") {
  const name = new S2RealtimeStreams({
    endpoint: s2.endpoint,
    basin: s2.basin,
    accessToken: "unused",
    streamPrefix: STREAM_PREFIX,
  }).toSessionStreamName(ctx.key, io);
  return new S2({
    accessToken: "unused",
    endpoints: { account: s2.host, basin: s2.host },
  })
    .basin(s2.basin)
    .stream(name);
}

async function appendRecords(
  ctx: Ctx,
  io: "in" | "out",
  records: Array<{ body: string; headers?: Array<[string, string]>; timestamp: number }>
) {
  await sessionStream(ctx, io).append(
    AppendInput.create(records.map((record) => AppendRecord.string(record)))
  );
}

/** The S2 `trim` command record the agent appends to `.out` after a turn-complete. */
async function pushTrim(ctx: Ctx, trimTo: number) {
  await sessionStream(ctx, "out").append(AppendInput.create([AppendRecord.trim(trimTo)]));
}

/**
 * S2 applies a trim shortly after its command record lands: wait until the `.out` peek reads
 * `expected`. Only that kind ends the wait, so a read that fails ("unknown") does not.
 */
async function waitForOutTail(ctx: Ctx, expected: SessionOutTail["kind"]) {
  const streams = new S2RealtimeStreams({
    endpoint: s2.endpoint,
    basin: s2.basin,
    accessToken: "unused",
    skipAccessTokens: true,
    streamPrefix: STREAM_PREFIX,
  });
  const deadline = Date.now() + 10_000;
  let kind: SessionOutTail["kind"] | undefined;
  while (Date.now() < deadline) {
    kind = (await streams.peekSessionOutTail(ctx.key)).kind;
    if (kind === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`.out never read as "${expected}" (last read: "${kind}")`);
}

let partCounter = 0;

/** A record on `.in` in the `{data, id}` envelope the append path writes. */
async function pushIn(ctx: Ctx, part: object, timestamp: number = Date.now()) {
  await appendRecords(ctx, "in", [
    {
      body: JSON.stringify({ data: JSON.stringify(part), id: `part_${partCounter++}` }),
      timestamp,
    },
  ]);
}

const message = (text: string) => ({
  kind: "message",
  payload: { chatId: CHAT_ID, trigger: "submit-message", message: { id: text } },
});

/**
 * The turn-complete the ended run wrote. It carries the `.in` cursor but not the newer
 * `session-in-consumed-id`, so this also covers an SDK that predates that header.
 */
async function pushTurnComplete(
  ctx: Ctx,
  inEventId: number | undefined,
  timestamp: number = Date.now()
) {
  await appendRecords(ctx, "out", [
    {
      body: "",
      headers: [
        [TRIGGER_CONTROL_HEADER, TRIGGER_CONTROL_SUBTYPE.TURN_COMPLETE],
        ...(inEventId !== undefined
          ? ([[SESSION_IN_EVENT_ID_HEADER, String(inEventId)]] as Array<[string, string]>)
          : []),
      ],
      timestamp,
    },
  ]);
}

/** A partial chunk of an answer on `.out`: what a run leaves when it dies mid-turn. */
async function pushChunk(ctx: Ctx, timestamp: number = Date.now()) {
  await appendRecords(ctx, "out", [
    { body: JSON.stringify({ type: "text-delta", delta: "par" }), timestamp },
  ]);
}

async function finish(prisma: PrismaClient, runId: string, status = "COMPLETED_SUCCESSFULLY") {
  await prisma.taskRun.update({
    where: { id: runId },
    data: { status: status as never, completedAt: new Date() },
  });
}

async function runEnded(
  ctx: Ctx,
  run: { id: string; createdAt: Date; sessionInSeq?: number; sessionInFirstSeq?: number },
  outcome?: "succeeded" | "failed"
) {
  return continueSessionIfInputUnread(
    { run, environmentId: ctx.seed.envId, outcome },
    { findEnvironment: async () => ctx.environment }
  );
}

/** What a session run's annotations record, read off the options it was triggered with. */
function recordedAnchors(options: Record<string, unknown>) {
  return {
    sessionInSeq: options.sessionInSeq as number | undefined,
    sessionInFirstSeq: options.sessionInFirstSeq as number | undefined,
  };
}

async function append(ctx: Ctx, session: any, part: object) {
  return ensureRunThenAppend({
    session,
    environment: ctx.environment,
    addressingKey: ctx.key,
    io: "in",
    part: JSON.stringify(part),
    reason: "continuation",
  });
}

let s2Container: StartedS2Container;

beforeAll(async () => {
  s2Container = await createS2Container();
  s2.host = s2Container.endpoint;
  s2.endpoint = `${s2Container.endpoint}/v1`;
  s2.basin = s2Container.basin;
}, 120_000);

afterAll(async () => {
  await s2Container?.container.stop();
});

describe("a session's input that no run read", () => {
  // Catches: a message appended while the run is still alive starts nothing (the append reuses the
  // live run), and the run then exits without reading it, so nothing answers it until a later
  // message revives the session.
  postgresTest(
    "starts a continuation when the current run ends without reading a message appended meanwhile",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"));
      await pushTurnComplete(ctx, 0);

      const appended = await append(ctx, session, message("m2"));
      expect(appended.ok && appended.ensure.ok && appended.ensure.result.triggered).toBe(false);
      expect(triggerState.calls).toHaveLength(0);

      await finish(prisma as unknown as PrismaClient, run.id);
      const outcome = await runEnded(ctx, run);

      expect(outcome).toBe("continued");
      expect(triggerState.calls).toHaveLength(1);
      expect(triggerState.calls[0]!.body.payload).toMatchObject({
        continuation: true,
        previousRunId: run.friendlyId,
      });
      const after = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      expect(after.currentRunId).not.toBe(run.id);
    }
  );

  // Catches: a continuation started after every run end, so a run that read everything costs the
  // customer another run each time it finishes.
  postgresTest("starts nothing when the run read everything on .in", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
    await pushIn(ctx, message("m1"));
    await pushIn(ctx, message("m2"));
    await pushTurnComplete(ctx, 1);
    await finish(prisma as unknown as PrismaClient, run.id);

    expect(await runEnded(ctx, run)).toBe("nothing-unread");
    expect(triggerState.calls).toHaveLength(0);
  });

  // Catches: counting any unread `.in` record as input, so a `stop`, a head-start signal, or the
  // `close` that `AgentChat.close()` sends (a `message` record with `trigger: "close"`) starts a
  // billed run that only reads it and exits.
  postgresTest("starts nothing for unread records that are not messages", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
    await pushIn(ctx, message("m1"));
    await pushTurnComplete(ctx, 0);
    await pushIn(ctx, { kind: "stop" });
    await pushIn(ctx, { kind: "handover-skip" });
    await pushIn(ctx, { kind: "handover", partialAssistantMessage: [], isFinal: true });
    // `AgentChat.close()` and a preload both ride in a `message` record, but neither is a turn.
    await pushIn(ctx, { kind: "message", payload: { chatId: CHAT_ID, trigger: "close" } });
    await pushIn(ctx, { kind: "message", payload: { chatId: CHAT_ID, trigger: "preload" } });
    await finish(prisma as unknown as PrismaClient, run.id);

    expect(await runEnded(ctx, run)).toBe("nothing-unread");
    expect(triggerState.calls).toHaveLength(0);
  });

  // Catches: reviving a conversation its owner has closed.
  postgresTest("starts nothing for a closed session", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx, true);
    await pushIn(ctx, message("m1"));
    await pushTurnComplete(ctx, 0);
    await pushIn(ctx, message("m2"));
    await finish(prisma as unknown as PrismaClient, run.id);

    expect(await runEnded(ctx, run)).toBe("not-a-session-run");
    expect(triggerState.calls).toHaveLength(0);
  });

  // Catches: a run that crashes at boot looking like it left the previous run's unread message
  // behind: each crash would start the next run, forever. A message older than the run is not its.
  postgresTest(
    "starts nothing for a message that was already there when the run began",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"), run.createdAt.getTime() - 20_000);
      await pushTurnComplete(ctx, 0, run.createdAt.getTime() - 10_000);
      await pushIn(ctx, message("m2"), run.createdAt.getTime() - 5_000);
      await finish(prisma as unknown as PrismaClient, run.id, "CRASHED");

      expect(await runEnded(ctx, run)).toBe("nothing-unread");
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: a preloaded run that times out waiting for its first message (no turn-complete at all,
  // `.out` empty) stranding a message that landed during its last moments.
  postgresTest(
    "a run that idled out before any turn still gets the message that arrived while it lived",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("first"), Date.now() - 1_000);
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run)).toBe("continued");
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: a continuation run that times out waiting for the next message trusting the previous
  // run's turn-complete: the message that landed after the wait gave up must still start a run.
  postgresTest(
    "a continuation run that idled out still gets the message that arrived while it lived",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"), run.createdAt.getTime() - 20_000);
      await pushTurnComplete(ctx, 0, run.createdAt.getTime() - 10_000);
      await pushIn(ctx, message("m2"), Date.now() - 1_000);
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run)).toBe("continued");
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: scanning the whole bounded window oldest-first on every run that wrote no turn, so the
  // usual answer on a long session (nothing new) costs every page read instead of one from the tail.
  postgresTest(
    "reads one page of a long input when nothing arrived while a run that wrote no turn lived",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      for (let i = 0; i < 350; i++) {
        await pushIn(ctx, message(`old${i}`), run.createdAt.getTime() - 60_000 + i);
      }
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run)).toBe("nothing-unread");
      expect(s2.readCalls).toBe(1);
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: the tail-first scan missing a message stored at the very end of a long input, or
  // reading more than the tail page to find it.
  postgresTest(
    "finds a message that arrived while the run lived at the tail of a long input in one read",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      for (let i = 0; i < 350; i++) {
        await pushIn(ctx, message(`old${i}`), run.createdAt.getTime() - 60_000 + i);
      }
      await pushIn(ctx, message("new"), Date.now() - 1_000);
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run)).toBe("continued");
      expect(s2.readCalls).toBe(1);
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: an off-by-one at the boundary between the tail page and the one before it, which
  // skips or re-reads the record there: the message sits just past the tail page.
  postgresTest(
    "finds a message that arrived while the run lived on the page before the tail",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      for (let i = 0; i < 200; i++) {
        await pushIn(ctx, message(`old${i}`), run.createdAt.getTime() - 60_000 + i);
      }
      const during = Date.now() - 1_000;
      await pushIn(ctx, message("new"), during);
      // 100 newer records that are not turns fill the tail page, so the message is the newest
      // record of the page before it.
      for (let i = 0; i < 100; i++) {
        await pushIn(ctx, { kind: "stop" }, during + 1 + i);
      }
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run)).toBe("continued");
      expect(s2.readCalls).toBe(2);
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: a run whose own last turn boundary carries no `.in` cursor (a turn started from the
  // payload, before the agent read `.in`) being judged from seq 0, so earlier runs' answered
  // messages count as unread and a continuation starts that may answer them again.
  postgresTest(
    "starts nothing when the run's own last boundary has no cursor and only earlier runs' messages are on .in",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"), run.createdAt.getTime() - 60_000);
      await pushIn(ctx, message("m2"), run.createdAt.getTime() - 30_000);
      await pushTurnComplete(ctx, undefined);
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run)).toBe("nothing-unread");
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: the same cursorless boundary hiding a message that did arrive while the run lived.
  postgresTest(
    "continues when the run's own last boundary has no cursor and a message arrived while it lived",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"), run.createdAt.getTime() - 60_000);
      await pushTurnComplete(ctx, undefined);
      await pushIn(ctx, message("m2"), Date.now());
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run)).toBe("continued");
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: a run that never gets to read the message (crashes at boot) being replaced by a run
  // that does the same, over and over: the next run began after the message, so it is not its.
  postgresTest("starts at most one run for a message that no run reads", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
    await pushIn(ctx, message("m1"), Date.now() - 1_000);
    await finish(prisma as unknown as PrismaClient, run.id);
    expect(await runEnded(ctx, run)).toBe("continued");

    const next = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
    const nextRun = await prisma.taskRun.findFirstOrThrow({ where: { id: next.currentRunId! } });
    await finish(prisma as unknown as PrismaClient, nextRun.id, "CRASHED");

    expect(await runEnded(ctx, { id: nextRun.id, createdAt: nextRun.createdAt })).toBe(
      "nothing-unread"
    );
    expect(triggerState.calls).toHaveLength(1);
  });

  // Catches: the same, once the runs record their anchors: the continuation is started for a
  // message already on `.in`, and the check that judges it must not read that message again.
  postgresTest(
    "starts at most one run for a message that no run reads, given the recorded anchors",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"));
      await finish(prisma as unknown as PrismaClient, run.id);
      expect(await runEnded(ctx, { ...run, sessionInSeq: 0 })).toBe("continued");

      const next = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      const nextRun = await prisma.taskRun.findFirstOrThrow({ where: { id: next.currentRunId! } });
      await finish(prisma as unknown as PrismaClient, nextRun.id, "CRASHED");

      expect(
        await runEnded(ctx, {
          id: nextRun.id,
          createdAt: nextRun.createdAt,
          ...recordedAnchors(triggerState.calls[0]!.options),
        })
      ).toBe("nothing-unread");
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: a retried completion job starting a second run after the first attempt already
  // started one (the job is delivered at least once).
  postgresTest(
    "running the check again after it started a run starts nothing",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"), Date.now() - 1_000);
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run)).toBe("continued");
      expect(await runEnded(ctx, run)).toBe("not-a-session-run");
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: only counting messages after a cursor when the run consumed something: a run whose
  // first turn came in its payload leaves no cursor, and a message appended during that turn is
  // unread.
  postgresTest(
    "counts every message as unread when the turn left no cursor",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushTurnComplete(ctx, undefined);
      await pushIn(ctx, message("m1"));
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run)).toBe("continued");
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: the append probing the run before the record lands and trusting it. The run can end
  // between that probe and the record landing, after which no completion check would run again for
  // it (the check had already read `.in`), so the message needs the append itself to look again.
  postgresTest(
    "the append starts a continuation when the run ends before the record lands",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"));
      await pushTurnComplete(ctx, 0);
      s2.beforeAppendLands = async () => {
        await finish(prisma as unknown as PrismaClient, run.id);
      };

      const appended = await append(ctx, session, message("m2"));

      expect(appended.ok && appended.ensure.ok && appended.ensure.result.triggered).toBe(true);
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: the re-check after the append reviving a run that was cancelled in the window before
  // the record landed: a cancel is a decision to stop (the run-end handlers skip it for the same
  // reason), but the re-check saw a final status and started a run that answered the message.
  postgresTest(
    "the append does not start a run when the run was cancelled before the record landed",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"));
      await pushTurnComplete(ctx, 0);
      s2.beforeAppendLands = async () => {
        await finish(prisma as unknown as PrismaClient, run.id, "CANCELED");
      };

      const appended = await append(ctx, session, message("m2"));

      expect(appended.ok).toBe(true);
      expect(triggerState.calls).toHaveLength(0);
      const after = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      expect(after.currentRunId).toBe(run.id);

      // The cancel stopped that run, not the conversation: the next append starts one as before.
      s2.beforeAppendLands = undefined;
      const next = await append(ctx, after, message("m3"));
      expect(next.ok && next.ensure.ok && next.ensure.result.triggered).toBe(true);
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: the append and the completion check each starting a run for the same message, so one
  // message is answered twice and a conversation holds two live runs.
  postgresTest(
    "an append and the completion check that race start exactly one run",
    async ({ prisma }) => {
      for (let round = 0; round < 4; round++) {
        const ctx = await setup(prisma as unknown as PrismaClient);
        const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
        await pushIn(ctx, message("m1"));
        await pushTurnComplete(ctx, 0);
        let completionCheck: Promise<unknown> | undefined;
        s2.beforeAppendLands = async () => {
          await finish(prisma as unknown as PrismaClient, run.id);
          completionCheck = runEnded(ctx, run);
        };

        const appended = await append(ctx, session, message("m2"));
        await completionCheck;

        expect(appended.ok).toBe(true);
        const sessionRuns = await prisma.sessionRun.findMany({ where: { sessionId: session.id } });
        const after = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
        const winner = await prisma.taskRun.findFirstOrThrow({
          where: { id: after.currentRunId! },
        });
        expect(after.currentRunId).not.toBe(run.id);
        expect(winner.status).toBe("PENDING");
        // One claim won; every other run triggered for the message was cancelled.
        expect(sessionRuns).toHaveLength(1);
        expect(cancelState.runIds).toHaveLength(triggerState.calls.length - 1);
      }
    }
  );

  // Catches: the webhook and channel delivery path appending to `.in` after its own ensure without
  // looking at the run again, so a delivery that races the run's end is never read.
  postgresTest(
    "a webhook delivery starts a continuation when the run ends before the record lands",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"));
      await pushTurnComplete(ctx, 0);
      s2.beforeAppendLands = async () => {
        await finish(prisma as unknown as PrismaClient, run.id);
      };

      const delivered = await deliverPartToSession({
        environment: ctx.environment,
        session,
        isCached: true,
        part: JSON.stringify(message("webhook")),
        partId: "delivery-1",
        claimPart: async () => "append",
        commitPart: async () => undefined,
        releasePart: async () => undefined,
      });

      expect(delivered.ok).toBe(true);
      expect(triggerState.calls).toHaveLength(1);
      const after = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      expect(after.currentRunId).not.toBe(run.id);
      expect(delivered.ok && delivered.runId).toBe(after.currentRunId);
    }
  );

  // Catches: the queued job treating "S2 gave no answer" as a clean finish, which acks it and
  // strands the message, instead of failing the attempt so the queue retries.
  postgresTest(
    "the queued job fails the attempt when the streams cannot be read",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"), Date.now() - 1_000);
      await finish(prisma as unknown as PrismaClient, run.id);
      s2.outUnreadable = true;

      await expect(
        runSessionRunCompletionJob(
          {
            runId: run.id,
            runCreatedAt: run.createdAt.toISOString(),
            environmentId: ctx.seed.envId,
          },
          { findEnvironment: async () => ctx.environment }
        )
      ).rejects.toThrow("Could not read the session streams");
      expect(triggerState.calls).toHaveLength(0);

      // The retry, with S2 answering again, starts the run.
      s2.outUnreadable = false;
      await runSessionRunCompletionJob(
        { runId: run.id, runCreatedAt: run.createdAt.toISOString(), environmentId: ctx.seed.envId },
        { findEnvironment: async () => ctx.environment }
      );
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: a tail of several trim commands after the turn-complete reading as "unreadable", so
  // the queued job throws on every attempt for a run that ended cleanly with nothing unread.
  postgresTest(
    "reads a run's turn-complete past two trims on .out: nothing unread",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"));
      await pushChunk(ctx);
      await pushTurnComplete(ctx, 0);
      await pushTrim(ctx, 1);
      await pushTrim(ctx, 1);
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run)).toBe("nothing-unread");
      await runSessionRunCompletionJob(
        { runId: run.id, runCreatedAt: run.createdAt.toISOString(), environmentId: ctx.seed.envId },
        { findEnvironment: async () => ctx.environment }
      );
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: the wider tail read answering "nothing unread" for a run whose `.out` ends in trims,
  // so a message the run never read is left unanswered.
  postgresTest(
    "still continues for an unread message when .out ends with two trims",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"));
      await pushChunk(ctx);
      await pushTurnComplete(ctx, 0);
      await pushTrim(ctx, 1);
      await pushTrim(ctx, 1);
      await pushIn(ctx, message("m2"));
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run)).toBe("continued");
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: a `.out` that holds only command records (a trim deleted the turn-complete) being
  // treated as empty, which scans `.in` from the run's start and starts a run that re-answers
  // messages the run already answered, or as unreadable, which retries a stream that cannot change.
  postgresTest(
    "a .out holding only command records is a final answer: nothing continued, no retry",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"));
      await pushChunk(ctx);
      await pushTurnComplete(ctx, 0);
      // The trim is seq 2: it deletes the turn-complete at seq 1 and everything below.
      await pushTrim(ctx, 2);
      await pushIn(ctx, message("m2"));
      await finish(prisma as unknown as PrismaClient, run.id);
      await waitForOutTail(ctx, "commands-only");

      expect(await runEnded(ctx, run)).toBe("out-commands-only");
      expect(triggerState.calls).toHaveLength(0);

      // The queue's first attempt and its last both end without throwing: nothing to retry.
      for (const attempt of [0, SESSION_RUN_COMPLETION_MAX_ATTEMPTS - 1]) {
        await expect(
          runSessionRunCompletionJob(
            {
              runId: run.id,
              runCreatedAt: run.createdAt.toISOString(),
              environmentId: ctx.seed.envId,
            },
            { findEnvironment: async () => ctx.environment },
            attempt
          )
        ).resolves.toBeUndefined();
      }
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: a trim far past the tail, which leaves `.out` with no records at all, being read as
  // an empty stream: the run-end check then scans `.in` from the run's start and starts a run that
  // re-answers messages the run already answered.
  postgresTest(
    "a fully trimmed .out with an unread .in message is out-commands-only and starts no run",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"));
      await pushChunk(ctx);
      await pushTurnComplete(ctx, 0);
      await pushTrim(ctx, 99);
      await pushIn(ctx, message("m2"));
      await finish(prisma as unknown as PrismaClient, run.id);
      await waitForOutTail(ctx, "commands-only");

      expect(await runEnded(ctx, run)).toBe("out-commands-only");
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: the queued job returning on its last attempt, which makes the worker acknowledge and
  // delete a check that never read the streams, so it can't be replayed from the dead-letter
  // queue; or throwing without the warn level, which reports every attempt as an error.
  postgresTest(
    "the queued job fails every unreadable attempt at warn level, the last one included, so the check reaches the dead-letter queue",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m1"), Date.now() - 1_000);
      await finish(prisma as unknown as PrismaClient, run.id);
      s2.outUnreadable = true;
      const attempt = (n: number) =>
        runSessionRunCompletionJob(
          {
            runId: run.id,
            runCreatedAt: run.createdAt.toISOString(),
            environmentId: ctx.seed.envId,
          },
          { findEnvironment: async () => ctx.environment },
          n
        );

      // The worker logs a thrown error at the level it carries: warn on every attempt. The last
      // attempt throws too, so the worker moves the check to its dead-letter queue (at warn) where
      // it can be replayed once the streams can be read; returning would acknowledge and drop it.
      for (let n = 0; n < SESSION_RUN_COMPLETION_MAX_ATTEMPTS; n++) {
        await expect(attempt(n)).rejects.toMatchObject({
          message: expect.stringContaining("Could not read the session streams"),
          logLevel: "warn",
        });
      }
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: the job payload's creation time (a string on the queue) not being turned back into a
  // date, which would compare every message against an invalid time and start nothing.
  postgresTest(
    "the queued job reads the run's creation time from its payload",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      // Older than the run, so it is not this run's to answer; newer than the run, it is.
      await pushIn(ctx, message("old"), run.createdAt.getTime() - 5_000);
      await finish(prisma as unknown as PrismaClient, run.id);
      const payload = {
        runId: run.id,
        runCreatedAt: run.createdAt.toISOString(),
        environmentId: ctx.seed.envId,
      };

      await runSessionRunCompletionJob(payload, { findEnvironment: async () => ctx.environment });
      expect(triggerState.calls).toHaveLength(0);

      await pushIn(ctx, message("during"), run.createdAt.getTime() + 5_000);
      await runSessionRunCompletionJob(payload, { findEnvironment: async () => ctx.environment });
      expect(triggerState.calls).toHaveLength(1);
    }
  );
});

// A run that FAILED gives the user no feedback and a retry can fail the same way, so the check does
// not retry the turn it died in: the user's next message starts a run. What it still continues is a
// message the run never started on, which a run that ended on its own turn-complete leaves behind.
describe("a run that failed", () => {
  // Catches: a run that died mid-turn (partial chunks after the message it was answering) being
  // replaced by a run that re-answers that message, which can crash the same way, again and again.
  postgresTest(
    "starts nothing when it died mid-turn, even with its message unread",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("previous"));
      await pushTurnComplete(ctx, 0);
      await pushIn(ctx, message("answering"));
      await pushChunk(ctx);
      await finish(prisma as unknown as PrismaClient, run.id, "CRASHED");

      expect(await runEnded(ctx, { ...run, sessionInSeq: 1 }, "failed")).toBe("failed-mid-turn");
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: a run that died at boot, before writing anything of its own, being judged by the
  // previous run's turn-complete: that record is stored with a newer timestamp than the run here
  // (S2's clock ahead), and carries a cursor below the run's `.in` start, so by seq it is not its own.
  postgresTest(
    "starts nothing when it died at boot behind a previous run's turn-complete",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("previous"));
      await pushTurnComplete(ctx, 0, run.createdAt.getTime() + 5_000);
      await pushIn(ctx, message("for the run that crashed"));
      await finish(prisma as unknown as PrismaClient, run.id, "CRASHED");

      expect(await runEnded(ctx, { ...run, sessionInSeq: 1 }, "failed")).toBe("failed-mid-turn");
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: a run that died at boot on a session whose `.out` is still empty being continued.
  postgresTest("starts nothing when it died at boot and `.out` is empty", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
    await pushIn(ctx, message("first"));
    await finish(prisma as unknown as PrismaClient, run.id, "CRASHED");

    expect(await runEnded(ctx, { ...run, sessionInSeq: 0 }, "failed")).toBe("failed-mid-turn");
    expect(triggerState.calls).toHaveLength(0);
  });

  // Catches: the failed rule swallowing the original bug for a failed run: it ended on its own
  // turn-complete (an `onSuccess` hook threw, or it crashed while idle) and a message that arrived
  // as it ended was never started on, so nothing answers it.
  postgresTest(
    "still continues a message past the cursor when it ended on its own turn-complete",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushTurnComplete(ctx, 0);
      await pushIn(ctx, message("arrived as it ended"));
      await finish(prisma as unknown as PrismaClient, run.id, "CRASHED");

      expect(await runEnded(ctx, { ...run, sessionInSeq: 0 }, "failed")).toBe("continued");
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: the failed rule starting a continuation when the run's own turn answered everything.
  postgresTest(
    "starts nothing when it ended on its own turn-complete that read everything",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushTurnComplete(ctx, 0);
      await finish(prisma as unknown as PrismaClient, run.id, "CRASHED");

      expect(await runEnded(ctx, { ...run, sessionInSeq: 0 }, "failed")).toBe("nothing-unread");
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: a failed run without an anchor (queued by older code, or its tail was unreadable)
  // being judged by nothing: it falls back to the timestamp, and a turn-complete older than the
  // run is a previous run's.
  postgresTest(
    "without an anchor, starts nothing when `.out` ends on a turn-complete older than the run",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"), run.createdAt.getTime() - 20_000);
      await pushTurnComplete(ctx, 0, run.createdAt.getTime() - 10_000);
      await pushIn(ctx, message("m1"), Date.now() - 1_000);
      await finish(prisma as unknown as PrismaClient, run.id, "CRASHED");

      expect(await runEnded(ctx, run, "failed")).toBe("failed-mid-turn");
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: a cursorless turn-complete (a turn started from the payload) counted as the run's own
  // under an anchor, where seqs cannot say whose it is: it could be a previous run's, so the run is
  // left to the user rather than risk a repeat.
  postgresTest(
    "starts nothing when its last turn-complete has no cursor to tell whose it is",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushTurnComplete(ctx, undefined);
      await pushIn(ctx, message("m0"));
      await finish(prisma as unknown as PrismaClient, run.id, "CRASHED");

      expect(await runEnded(ctx, { ...run, sessionInSeq: 0 }, "failed")).toBe("failed-mid-turn");
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: the outcome leaking into a succeeded run: one that ended without finishing a turn it
  // started (a clean exit with partial chunks, or one that idled out) is still continued.
  postgresTest("a succeeded run is continued whatever its `.out` ends on", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
    await pushIn(ctx, message("m0"));
    await pushChunk(ctx);
    await finish(prisma as unknown as PrismaClient, run.id);

    expect(await runEnded(ctx, { ...run, sessionInSeq: 0 }, "succeeded")).toBe("continued");
    expect(triggerState.calls).toHaveLength(1);
  });

  // Catches: a job queued by older code (no outcome in its payload) parsing differently: it keeps
  // today's rule and continues, as the unchanged cases above do.
  postgresTest("a job without an outcome keeps today's rule", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
    await pushIn(ctx, message("m0"));
    await pushChunk(ctx);
    await finish(prisma as unknown as PrismaClient, run.id, "CRASHED");

    const parsed = SessionRunCompletionPayloadSchema.parse({
      runId: run.id,
      runCreatedAt: run.createdAt.toISOString(),
      environmentId: ctx.seed.envId,
      sessionInSeq: 0,
    });
    expect(parsed.outcome).toBeUndefined();
    await runSessionRunCompletionJob(parsed, { findEnvironment: async () => ctx.environment });
    expect(triggerState.calls).toHaveLength(1);
  });

  // Catches: the job throwing for "failed-mid-turn", which would have the queue retry a check whose
  // answer is final.
  postgresTest(
    "the queued job passes the outcome and finishes without retrying when it leaves the run",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushChunk(ctx);
      await finish(prisma as unknown as PrismaClient, run.id, "CRASHED");

      await expect(
        runSessionRunCompletionJob(
          {
            runId: run.id,
            runCreatedAt: run.createdAt.toISOString(),
            environmentId: ctx.seed.envId,
            sessionInSeq: 0,
            outcome: "failed",
          },
          { findEnvironment: async () => ctx.environment }
        )
      ).resolves.toBeUndefined();
      expect(triggerState.calls).toHaveLength(0);
    }
  );
});

// Whose turn-complete is it: by seq when the run recorded where `.in` stood at its start.
describe("whose turn-complete ends `.out`", () => {
  // Catches: judging ownership by timestamp, so a run's own turn-complete stored with a timestamp
  // older than the run (S2's clock behind ours) is taken as not its own, and the message that turn
  // answered, at or past the anchor, is read as unread and answered a second time.
  postgresTest(
    "a turn-complete stamped older than the run, with a cursor at or past the anchor, is its own",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("answered"));
      await pushTurnComplete(ctx, 0, run.createdAt.getTime() - 10_000);
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, { ...run, sessionInSeq: 0 })).toBe("nothing-unread");
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: judging ownership by timestamp the other way: a previous run's turn-complete stamped
  // newer than the run (S2's clock ahead), with a cursor below the anchor, taken as the run's own.
  postgresTest(
    "a turn-complete stamped newer than the run, with a cursor below the anchor, is not its own",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushIn(ctx, message("m1"));
      await pushTurnComplete(ctx, 0, run.createdAt.getTime() + 5_000);
      await finish(prisma as unknown as PrismaClient, run.id);

      // m1 is below the anchor: the previous run's, whatever the turn-complete's timestamp says.
      expect(await runEnded(ctx, { ...run, sessionInSeq: 2 })).toBe("nothing-unread");
      expect(triggerState.calls).toHaveLength(0);
    }
  );
});

// The check anchors on `.in` seqs captured when the run was triggered, not on S2's clock against
// ours: a record's timestamp and `TaskRun.createdAt` come from different clocks. The skew in these
// tests is simulated by choosing the timestamps the records are stored at.
describe("a run that recorded the .in seq it was triggered at", () => {
  // Catches: judging an arrival by timestamp, so a message that landed a few ms after the run was
  // created but is stored with a timestamp older than `createdAt` (S2's clock behind ours) is
  // taken as the previous run's and never continued.
  postgresTest(
    "continues a message past the anchor whose timestamp is older than the run",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("previous"), run.createdAt.getTime() - 60_000);
      await pushIn(ctx, message("arrived"), run.createdAt.getTime() - 1_000);
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, { ...run, sessionInSeq: 1 })).toBe("continued");
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: judging an arrival by timestamp, so a previous run's message stored with a timestamp
  // newer than `createdAt` (S2's clock ahead) counts as this run's and starts one run too many.
  postgresTest(
    "starts nothing for a message below the anchor whose timestamp is newer than the run",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("previous"), run.createdAt.getTime() + 5_000);
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, { ...run, sessionInSeq: 1 })).toBe("nothing-unread");
      expect(s2.readCalls).toBe(0);
      expect(triggerState.calls).toHaveLength(0);
    }
  );

  // Catches: counting any record past the anchor as input: a `stop` is not a message to answer.
  postgresTest("ignores records past the anchor that are not turn messages", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
    await pushIn(ctx, message("previous"), run.createdAt.getTime() - 60_000);
    await pushIn(ctx, { kind: "stop" }, run.createdAt.getTime() + 1_000);
    await finish(prisma as unknown as PrismaClient, run.id);

    expect(await runEnded(ctx, { ...run, sessionInSeq: 1 })).toBe("nothing-unread");
  });

  // Catches: the anchor only applying to a run that wrote no turn: a run whose last turn carries no
  // cursor is judged the same way, from the anchor, so a previous run's message does not count.
  postgresTest(
    "applies the anchor when the run's last turn boundary has no cursor",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("previous"), run.createdAt.getTime() + 5_000);
      await pushTurnComplete(ctx, undefined);
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, { ...run, sessionInSeq: 1 })).toBe("nothing-unread");
    }
  );

  // Catches: the scan from the anchor reading the whole input instead of its bounded pages when
  // everything after the anchor is not a message.
  postgresTest("reads at most three pages past the anchor", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
    await appendRecords(
      ctx,
      "in",
      Array.from({ length: 450 }, (_, i) => ({
        body: JSON.stringify({ data: JSON.stringify({ kind: "stop" }), id: `stop_${i}` }),
        timestamp: Date.now(),
      }))
    );
    await finish(prisma as unknown as PrismaClient, run.id);

    expect(await runEnded(ctx, { ...run, sessionInSeq: 0 })).toBe("nothing-unread");
    expect(s2.readCalls).toBe(3);
  });

  // Catches: the job payload dropping the anchor between the queue and the check, which would
  // judge by timestamp again.
  postgresTest("the queued job passes the anchor from its payload", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
    await pushIn(ctx, message("previous"), run.createdAt.getTime() + 5_000);
    await finish(prisma as unknown as PrismaClient, run.id);

    await runSessionRunCompletionJob(
      {
        runId: run.id,
        runCreatedAt: run.createdAt.toISOString(),
        environmentId: ctx.seed.envId,
        sessionInSeq: 1,
      },
      { findEnvironment: async () => ctx.environment }
    );
    expect(triggerState.calls).toHaveLength(0);
  });
});

describe("the .in seq captured when a session run is triggered", () => {
  // Catches: the seq being read after the trigger (a message appended in between would then be
  // below the anchor and never continued), or missing from one of the trigger paths.
  postgresTest(
    "an ensured run is triggered with the .in tail seq read before it",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushIn(ctx, message("m1"));
      await pushIn(ctx, message("m2"));
      await finish(prisma as unknown as PrismaClient, run.id);

      const ensured = await ensureRunForSession({
        session,
        environment: ctx.environment,
        reason: "continuation",
        probeOnWriter: true,
      });

      expect(ensured.triggered).toBe(true);
      expect(triggerState.calls).toHaveLength(1);
      expect(triggerState.calls[0]!.options.sessionInSeq).toBe(3);
    }
  );

  // Catches: the swap path (end-and-continue, upgrade) not capturing the anchor, so its run's
  // end is judged by timestamp.
  postgresTest("a swapped run is triggered with the .in tail seq", async ({ prisma }) => {
    const ctx = await setup(prisma as unknown as PrismaClient);
    const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
    await pushIn(ctx, message("m0"));
    await pushIn(ctx, message("m1"));

    const swapped = await swapSessionRun({
      session,
      callingRunId: run.id,
      environment: ctx.environment,
      reason: "manual",
    });

    expect(swapped.swapped).toBe(true);
    expect(triggerState.calls).toHaveLength(1);
    expect(triggerState.calls[0]!.options.sessionInSeq).toBe(2);
  });

  // Catches: a failed tail read failing the trigger: the anchor is an optimisation of the check,
  // and the run must start without it.
  postgresTest(
    "triggers the run without an anchor when the tail cannot be read",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await finish(prisma as unknown as PrismaClient, run.id);
      s2.inTailThrows = true;

      const ensured = await ensureRunForSession({
        session,
        environment: ctx.environment,
        reason: "continuation",
        probeOnWriter: true,
      });

      expect(ensured.triggered).toBe(true);
      expect(triggerState.calls[0]!.options.sessionInSeq).toBeUndefined();
    }
  );
});

describe("the .in seq a run is started for, when its messages are already on .in", () => {
  // Catches: a run revived after the append (the record is on `.in` before the run exists) being
  // anchored at the tail read at trigger time, which sits above the very message it answers, so its
  // own turn-complete is judged "not its own".
  postgresTest(
    "a run revived after an append records the seq of the record that append wrote",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushTurnComplete(ctx, 0);
      s2.beforeAppendLands = async () => {
        await finish(prisma as unknown as PrismaClient, run.id);
      };

      const appended = await append(ctx, session, message("m1"));

      expect(appended.ok && appended.seq).toBe(1);
      expect(triggerState.calls).toHaveLength(1);
      expect(triggerState.calls[0]!.options.sessionInFirstSeq).toBe(1);
      expect(triggerState.calls[0]!.options.sessionInSeq).toBe(2);
    }
  );

  // Catches: the webhook delivery's revive dropping the seq of the record it appended.
  postgresTest(
    "a run revived after a webhook delivery records the seq of the delivered record",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushTurnComplete(ctx, 0);
      s2.beforeAppendLands = async () => {
        await finish(prisma as unknown as PrismaClient, run.id);
      };

      await deliverPartToSession({
        environment: ctx.environment,
        session,
        isCached: true,
        part: JSON.stringify(message("webhook")),
        partId: "delivery-seq",
        claimPart: async () => "append",
        commitPart: async () => undefined,
        releasePart: async () => undefined,
      });

      expect(triggerState.calls).toHaveLength(1);
      expect(triggerState.calls[0]!.options.sessionInFirstSeq).toBe(1);
      expect(triggerState.calls[0]!.options.sessionInSeq).toBe(2);
    }
  );

  // Catches: a revived run that answers its message, then fails while idle as the next message
  // lands, being judged "failed mid-turn" (nothing answers the next message) because its anchor
  // sat above the message it answered.
  postgresTest(
    "a revived run that answered its message and failed while idle is continued for the next one",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushTurnComplete(ctx, 0);
      s2.beforeAppendLands = async () => {
        await finish(prisma as unknown as PrismaClient, run.id);
      };
      await append(ctx, session, message("m1"));
      s2.beforeAppendLands = undefined;
      const revived = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      const revivedRun = {
        id: revived.currentRunId!,
        createdAt: new Date(Date.now() - 1_000),
        ...recordedAnchors(triggerState.calls[0]!.options),
      };
      await pushTurnComplete(ctx, 1);
      await pushIn(ctx, message("m2"));
      await finish(prisma as unknown as PrismaClient, revivedRun.id, "CRASHED");

      expect(await runEnded(ctx, revivedRun, "failed")).toBe("continued");
      expect(triggerState.calls).toHaveLength(2);
    }
  );

  // Catches: the continuation the check starts being anchored at the tail, above the message it
  // was started for, so that run's own turn is judged not its own when it ends.
  postgresTest(
    "the continuation the check starts records the seq of the first unread message",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushTurnComplete(ctx, 0);
      await pushIn(ctx, message("m1"));
      await pushIn(ctx, message("m2"));
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run, "succeeded")).toBe("continued");
      expect(triggerState.calls[0]!.options.sessionInFirstSeq).toBe(1);
      expect(triggerState.calls[0]!.options.sessionInSeq).toBe(3);
    }
  );

  // Catches: the same, for a run that wrote no turn of its own and left no cursor to boot from:
  // the first unread message is found by the forward scan from the run's anchor, and its seq is
  // what the continuation records.
  postgresTest(
    "the continuation after a run that wrote no turn records the first unread message's seq",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushIn(ctx, message("m1"));
      await pushIn(ctx, message("m2"));
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, { ...run, sessionInSeq: 1 }, "succeeded")).toBe("continued");
      expect(triggerState.calls[0]!.options.sessionInFirstSeq).toBe(1);
      expect(triggerState.calls[0]!.options.sessionInSeq).toBe(3);
    }
  );

  // Catches: one anchor doing both jobs (owning a turn-complete, and starting the scan of a run
  // that wrote no turn): a continuation started for an unread message that ends without writing a
  // turn finds that message again and starts another run, forever. The scan must start at the tail
  // read when it was triggered, so a run is only held to messages that arrived after it started.
  postgresTest(
    "a continuation that ends without writing a turn does not start another for the same message",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushTurnComplete(ctx, 0);
      await pushIn(ctx, message("m1"));
      await finish(prisma as unknown as PrismaClient, run.id);

      expect(await runEnded(ctx, run, "succeeded")).toBe("continued");
      expect(triggerState.calls[0]!.options.sessionInFirstSeq).toBe(1);
      expect(triggerState.calls[0]!.options.sessionInSeq).toBe(2);

      // The continuation ends successfully with nothing of its own on `.out`.
      const next = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      const nextRun = await prisma.taskRun.findFirstOrThrow({ where: { id: next.currentRunId! } });
      await finish(prisma as unknown as PrismaClient, nextRun.id);

      expect(
        await runEnded(
          ctx,
          {
            id: nextRun.id,
            createdAt: nextRun.createdAt,
            ...recordedAnchors(triggerState.calls[0]!.options),
          },
          "succeeded"
        )
      ).toBe("nothing-unread");
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: the ownership anchor moving to the tail: a continuation that wrote its own turn for
  // its first message (cursor at the first seq, below the tail it was triggered at) and then fails
  // while idle must still be continued for the next message.
  postgresTest(
    "a continuation that answered its message and failed while idle is continued for the next one",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushTurnComplete(ctx, 0);
      await pushIn(ctx, message("m1"));
      await finish(prisma as unknown as PrismaClient, run.id);
      expect(await runEnded(ctx, run, "succeeded")).toBe("continued");

      const next = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      const nextRun = await prisma.taskRun.findFirstOrThrow({ where: { id: next.currentRunId! } });
      await pushTurnComplete(ctx, 1);
      await pushIn(ctx, message("m2"));
      await finish(prisma as unknown as PrismaClient, nextRun.id, "CRASHED");

      expect(
        await runEnded(
          ctx,
          {
            id: nextRun.id,
            createdAt: nextRun.createdAt,
            ...recordedAnchors(triggerState.calls[0]!.options),
          },
          "failed"
        )
      ).toBe("continued");
      expect(triggerState.calls).toHaveLength(2);
    }
  );
});

describe("the first .in seq of a run revived after an append", () => {
  // Catches: the revive recording the appended seq when the run that ended before the revive had
  // already answered it: the replacement's first seq then sits at a message an earlier run
  // consumed, so that run's turn-complete is taken as the replacement's own, and a replacement that
  // fails at boot is continued (a retry after a failure) instead of left to the user.
  postgresTest(
    "a replacement revived after its predecessor answered the appended message is not continued when it fails at boot",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushTurnComplete(ctx, 0);
      // The append reuses the live run, which answers the appended message and ends before the
      // append's own re-check of the run.
      s2.afterAppendLands = async () => {
        await pushTurnComplete(ctx, 1);
        await finish(prisma as unknown as PrismaClient, run.id);
      };

      const appended = await append(ctx, session, message("m1"));
      s2.afterAppendLands = undefined;

      expect(appended.ok && appended.seq).toBe(1);
      expect(triggerState.calls).toHaveLength(1);
      expect(triggerState.calls[0]!.options.sessionInFirstSeq).toBe(2);
      expect(triggerState.calls[0]!.options.sessionInSeq).toBe(2);

      // The next message lands behind the replacement, which then fails at boot with nothing on
      // `.out` of its own: the previous run's turn-complete is not its own.
      await pushIn(ctx, message("m2"));
      const revived = await prisma.session.findFirstOrThrow({ where: { id: session.id } });
      const revivedRun = {
        id: revived.currentRunId!,
        createdAt: new Date(Date.now() - 1_000),
        ...recordedAnchors(triggerState.calls[0]!.options),
      };
      await finish(prisma as unknown as PrismaClient, revivedRun.id, "CRASHED");

      expect(await runEnded(ctx, revivedRun, "failed")).toBe("failed-mid-turn");
      expect(triggerState.calls).toHaveLength(1);
    }
  );

  // Catches: concurrent appends where a later one wins the revive and records its own seq as the
  // first seq, above an earlier message that is on `.in` and unread: the replacement boots from the
  // last turn-complete's cursor and answers that earlier message too.
  postgresTest(
    "a revive by a later append records the boot cursor, not its own seq, when an earlier message is unread",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushTurnComplete(ctx, 0);
      // An earlier append's record (seq 1) landed first and has not revived yet; the run ends.
      s2.beforeAppendLands = async () => {
        await pushIn(ctx, message("m1"));
        await finish(prisma as unknown as PrismaClient, run.id);
      };

      const appended = await append(ctx, session, message("m2"));

      expect(appended.ok && appended.seq).toBe(2);
      expect(triggerState.calls).toHaveLength(1);
      expect(triggerState.calls[0]!.options.sessionInFirstSeq).toBe(1);
      expect(triggerState.calls[0]!.options.sessionInSeq).toBe(3);
    }
  );

  // Catches: the boot cursor replacing the appended seq when `.out` has no turn-complete cursor to
  // boot from: a run that wrote nothing leaves the appended message as the earliest one known.
  postgresTest(
    "a revive with no turn-complete cursor on .out records the appended seq",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      s2.beforeAppendLands = async () => {
        await finish(prisma as unknown as PrismaClient, run.id);
      };

      const appended = await append(ctx, session, message("m1"));

      expect(appended.ok && appended.seq).toBe(1);
      expect(triggerState.calls[0]!.options.sessionInFirstSeq).toBe(1);
    }
  );

  // Catches: a failed `.out` peek failing the revive, or dropping the first seq: the append
  // stands, and the replacement still records the appended seq.
  postgresTest(
    "a revive whose .out tail cannot be read still starts the run at the appended seq",
    async ({ prisma }) => {
      const ctx = await setup(prisma as unknown as PrismaClient);
      const { session, run } = await sessionWithLiveRun(prisma as unknown as PrismaClient, ctx);
      await pushIn(ctx, message("m0"));
      await pushTurnComplete(ctx, 0);
      s2.beforeAppendLands = async () => {
        await finish(prisma as unknown as PrismaClient, run.id);
        s2.outUnreadable = true;
      };

      const appended = await append(ctx, session, message("m1"));

      expect(appended.ok && appended.seq).toBe(1);
      expect(triggerState.calls).toHaveLength(1);
      expect(triggerState.calls[0]!.options.sessionInFirstSeq).toBe(1);
    }
  );
});
