// Run on Node 20; `--help` lists the verbs.
// Walkthroughs: internal-packages/dashboard-agent/GUIDEBOOK.md
import { ClickHouse, TASK_RUN_COLUMNS } from "@internal/clickhouse";
import type { QueueMetricsRawV1Input } from "@internal/clickhouse";
import { randomUUID } from "node:crypto";
// oxlint-disable import/default -- deliberate CommonJS interop: this entry is ESM,
// tsx compiles the app's `.ts` to CommonJS, and an ESM importer reaches a CommonJS
// module's exports only through `default`.
import dbServer from "./app/db.server";
import errorFingerprinting from "./app/utils/errorFingerprinting";
import eventCommon from "./app/v3/eventRepository/common.server";

const { prisma } = dbServer;
const { calculateErrorFingerprint } = errorFingerprinting;
const { generateTraceId, generateSpanId } = eventCommon;

const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3030";

const DEFAULT_RUN_SECONDS = 60;
const DEFAULT_FAIL_TASK = "slow-fail";
const DEFAULT_SUCCEED_TASK = "slow-succeed";

/** One fixed shape: the fingerprint has to stay stable across runs. */
const SCENARIO_ERROR = {
  type: "BUILT_IN_ERROR",
  name: "ProviderError",
  message: "429 Too Many Requests (rate_limit_exceeded)",
  stackTrace: `ProviderError: 429 Too Many Requests (rate_limit_exceeded)
    at sendEmail (src/trigger/scenarioKit.ts:31:11)
    at run (src/trigger/scenarioKit.ts:18:5)`,
};
const SCENARIO_ERROR_FINGERPRINT = calculateErrorFingerprint(SCENARIO_ERROR);
const SCENARIO_TASK_ID = "scenario-kit-task";
const SCENARIO_QUEUE_NAME = "scenario-kit";

function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

function parseFlags(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    // `pnpm run <script> -- <verb>` forwards the bare separator too.
    if (token === "--") continue;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return { positional, flags };
}

type Target = {
  organizationId: string;
  projectId: string;
  projectSlug: string;
  environmentId: string;
  environmentSlug: string;
  environmentType: string;
  apiKey: string;
  envConcurrencyLimit: number;
};

const ENV_ALIASES: Record<string, string> = {
  dev: "DEVELOPMENT",
  development: "DEVELOPMENT",
  staging: "STAGING",
  prod: "PRODUCTION",
  production: "PRODUCTION",
  preview: "PREVIEW",
};

async function resolveTarget(
  projectFlag: string | undefined,
  envFlag: string | undefined
): Promise<Target> {
  if (!projectFlag) {
    const projects = await prisma.project.findMany({
      where: { deletedAt: null },
      select: { slug: true },
      take: 20,
      orderBy: { createdAt: "desc" },
    });
    fail(
      `Pass --project <ref-or-slug>. Local projects: ` +
        `${projects.map((p: { slug: string }) => p.slug).join(", ") || "(none — run `pnpm run db:seed`)"}`
    );
  }
  const project = await prisma.project.findFirst({
    where: {
      deletedAt: null,
      OR: [{ externalRef: projectFlag }, { slug: projectFlag }, { name: projectFlag }],
    },
  });
  if (!project) {
    fail(`No project matched "${projectFlag}" (tried external ref, slug and name).`);
  }

  const alias = ENV_ALIASES[(envFlag ?? "dev").toLowerCase()];
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      projectId: project.id,
      ...(alias ? { type: alias as never } : { slug: envFlag }),
    },
  });
  if (!environment) {
    const environments = await prisma.runtimeEnvironment.findMany({
      where: { projectId: project.id },
      select: { slug: true, type: true },
    });
    fail(
      `No "${envFlag ?? "dev"}" environment on ${project.slug}. It has: ` +
        environments.map((e: { slug: string; type: string }) => `${e.slug} (${e.type})`).join(", ")
    );
  }

  return {
    organizationId: project.organizationId,
    projectId: project.id,
    projectSlug: project.slug,
    environmentId: environment.id,
    environmentSlug: environment.slug,
    environmentType: environment.type,
    apiKey: environment.apiKey,
    envConcurrencyLimit: environment.maximumConcurrencyLimit,
  };
}

async function requireQueue(target: Target, name: string) {
  const queue = await prisma.taskQueue.findFirst({
    where: { runtimeEnvironmentId: target.environmentId, name },
    select: { name: true },
  });
  if (queue) return;
  const queues = await prisma.taskQueue.findMany({
    where: { runtimeEnvironmentId: target.environmentId },
    select: { name: true },
  });
  fail(
    `No queue "${name}" in ${target.projectSlug}/${target.environmentSlug}. It has: ` +
      `${queues.map((row: { name: string }) => row.name).join(", ") || "(none — trigger a run first)"}`
  );
}

async function pickMetricsQueue(target: Target, queueFlag: string | undefined): Promise<string> {
  if (queueFlag) return queueFlag;
  const queue = await prisma.taskQueue.findFirst({
    where: { runtimeEnvironmentId: target.environmentId },
    select: { name: true },
    orderBy: { name: "asc" },
  });
  return queue?.name ?? SCENARIO_QUEUE_NAME;
}

type RedisLike = {
  del: (key: string) => Promise<unknown>;
  zadd: (key: string, ...args: Array<string | number>) => Promise<unknown>;
  zcard: (key: string) => Promise<number>;
  quit: () => Promise<unknown>;
};

const ZADD_BATCH = 1_000;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function envQueueKey(organizationId: string, environmentId: string): string {
  return `engine:runqueue:{org:${organizationId}}:env:${environmentId}`;
}

/** Must match the key `engine.lengthOfQueue` reads. */
function queueDepthKey(
  organizationId: string,
  projectId: string,
  environmentId: string,
  queueName: string
): string {
  return `engine:runqueue:{org:${organizationId}}:proj:${projectId}:env:${environmentId}:queue:${queueName}`;
}

async function openRedis(): Promise<RedisLike> {
  const host = process.env.RUN_ENGINE_RUN_QUEUE_REDIS_HOST ?? process.env.REDIS_HOST ?? "localhost";
  const port = Number(
    process.env.RUN_ENGINE_RUN_QUEUE_REDIS_PORT ?? process.env.REDIS_PORT ?? 6379
  );
  if (!LOCAL_HOSTS.has(host)) {
    fail(`Refusing to stage Redis on a non-local host: ${host}`);
  }
  const { createRedisClient } = await import("@internal/redis");
  return createRedisClient({ host, port }) as unknown as RedisLike;
}

/** Scores are timestamps: the queue's ages. */
async function writeZsetDepth(
  redis: RedisLike,
  key: string,
  depth: number,
  memberPrefix: string,
  /** The wait-limit watch reads the oldest score. */
  ageMinutes = 0
) {
  await redis.del(key);
  const oldest = Date.now() - ageMinutes * 60_000;
  for (let i = 0; i < depth; i += ZADD_BATCH) {
    const args: Array<string | number> = [];
    for (let j = i; j < Math.min(depth, i + ZADD_BATCH); j++) {
      args.push(oldest + j, `${memberPrefix}${j}`);
    }
    await redis.zadd(key, ...args);
  }
}

async function stageDepth(
  target: Target,
  queueName: string,
  depth: number,
  ageMinutes = 0
): Promise<{ perQueue: number; env: number }> {
  const redis = await openRedis();
  try {
    await writeZsetDepth(
      redis,
      envQueueKey(target.organizationId, target.environmentId),
      depth,
      "scenario_env_"
    );
    const perQueueKey = queueDepthKey(
      target.organizationId,
      target.projectId,
      target.environmentId,
      queueName
    );
    await writeZsetDepth(redis, perQueueKey, depth, "scenario_q_", ageMinutes);
    const perQueue = await redis.zcard(perQueueKey);
    const env = await redis.zcard(envQueueKey(target.organizationId, target.environmentId));
    await redis.quit();
    return { perQueue, env };
  } catch (error) {
    fail(
      `Redis is unreachable (${error instanceof Error ? error.message : error}). ` +
        `Is \`pnpm run docker\` up?`
    );
  }
}

type RawCommand = {
  command: (a: { query: string }) => Promise<unknown>;
  query: (a: { query: string; format: string }) => Promise<{ json: () => Promise<unknown> }>;
};

function clickhouse(): ClickHouse {
  const url = process.env.CLICKHOUSE_URL ?? process.env.EVENTS_CLICKHOUSE_URL;
  if (!url) {
    fail("CLICKHOUSE_URL not set. Is `pnpm run docker` up and apps/webapp/.env in place?");
  }
  const parsed = new URL(url);
  // Never echo the URL: it carries credentials.
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    fail(`Refusing to run against a non-local ClickHouse host: ${parsed.hostname}`);
  }
  parsed.searchParams.delete("secure");
  return new ClickHouse({ url: parsed.toString(), name: "watch-scenarios" });
}

function rawClient(ch: ClickHouse): RawCommand {
  return (ch.writer as unknown as { client: RawCommand }).client;
}

/** Blocks until no mutation is outstanding: an insert mid-mutation resurrects rows. */
async function waitForMutations(raw: RawCommand, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await raw.query({
      query: `SELECT count() AS pending FROM system.mutations
              WHERE is_done = 0 AND database = 'trigger_dev'`,
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Array<{ pending: string | number }>;
    if (Number(rows[0]?.pending ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.warn("Mutations still running after the wait — reads may lag a little.");
}

function chDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function queueFill(target: Target, queueName: string, depth: number, ageMinutes: number) {
  await requireQueue(target, queueName);
  const seen = await stageDepth(target, queueName, depth, ageMinutes);
  if (seen.perQueue !== depth) {
    fail(`Staged ${depth} but ${queueName} reads ${seen.perQueue}. Redis did not take the write.`);
  }
  const ageLine =
    ageMinutes > 0
      ? `    "if runs wait too long"  a limit under ${ageMinutes} minutes → fires on the next check`
      : `    "if runs wait too long"  re-run with --age-min N to backdate the oldest run first`;
  console.log(`
${queueName} is at ${depth}${
    ageMinutes > 0 ? `, oldest run waiting ${ageMinutes}m` : ""
  } (env-level ${seen.env}).

Next, in the dashboard:
  Queues → ${queueName} → Watch… → Customize
    "if it grows"            above a threshold under ${depth} → fires on the next check
    "when it's back below"   below a threshold under ${depth} → run queue:drain (or a smaller fill) to satisfy it
${ageLine}
  A queue watch checks every 5 minutes at the fastest, so allow one cadence.`);
}

async function queueDrain(target: Target, queueName: string) {
  await requireQueue(target, queueName);
  const seen = await stageDepth(target, queueName, 0);
  if (seen.perQueue !== 0) {
    fail(`${queueName} still reads ${seen.perQueue}. Redis did not take the write.`);
  }
  console.log(`
${queueName} is empty.

An armed "when it drains" watch resolves on its next check (≤5 min) with
"${queueName} queue drained". Arm the watch BEFORE draining — a drain watch
created against an already-empty queue one-shots with "That already happened".`);
}

// Written to `task_runs_v2` so the error materialized views build the group themselves.
async function errorRecur(target: Target, taskFlag: string | undefined) {
  const taskIdentifier = taskFlag ?? (await pickErrorTask(target));
  const ch = clickhouse();
  const now = Date.now();
  const runId = randomUUID().replaceAll("-", "");
  const row: Record<string, unknown> = {
    environment_id: target.environmentId,
    organization_id: target.organizationId,
    project_id: target.projectId,
    run_id: runId,
    updated_at: now,
    created_at: now,
    status: "COMPLETED_WITH_ERRORS",
    environment_type: target.environmentType,
    friendly_id: `run_${randomUUID().replaceAll("-", "").slice(0, 21)}`,
    attempt: 1,
    engine: "V2",
    task_identifier: taskIdentifier,
    queue: SCENARIO_QUEUE_NAME,
    schedule_id: "",
    batch_id: "",
    completed_at: now,
    started_at: now - 1_000,
    executed_at: now - 1_000,
    delay_until: null,
    queued_at: now - 2_000,
    expired_at: null,
    usage_duration_ms: 1_000,
    cost_in_cents: 0,
    base_cost_in_cents: 0,
    output: null,
    // The error-group materialized views read `error.data.name` / `.message` / `.stack`.
    error: { data: SCENARIO_ERROR },
    error_fingerprint: SCENARIO_ERROR_FINGERPRINT,
    tags: [],
    task_version: "20260101.1",
    sdk_version: "4.0.0",
    cli_version: "4.0.0",
    machine_preset: "small-1x",
    root_run_id: "",
    parent_run_id: "",
    depth: 0,
    span_id: generateSpanId(),
    trace_id: generateTraceId(),
    idempotency_key: "",
    idempotency_key_user: "",
    idempotency_key_scope: "",
    expiration_ttl: "",
    is_test: false,
    _version: String(now),
    _is_deleted: 0,
    concurrency_key: "",
    bulk_action_group_ids: [],
    worker_queue: "main",
    region: "",
    plan_type: "",
    max_duration_in_seconds: null,
    trigger_source: "API",
    root_trigger_source: "API",
    task_kind: "",
    is_warm_start: null,
  };

  const [error] = await ch.taskRuns.insertCompactArrays(
    [TASK_RUN_COLUMNS.map((column) => row[column])] as never,
    {
      params: {
        clickhouse_settings: { async_insert: 0, insert_deduplication_token: `scenario:${runId}` },
      },
    }
  );
  if (error) {
    await ch.close();
    fail(`task_runs_v2 insert failed: ${error.message}`);
  }

  // The groups are Aggregating/SummingMergeTrees; a read straight after can't wait for a merge.
  const raw = rawClient(ch);
  for (const table of ["errors_v1", "error_occurrences_v1"]) {
    await raw.command({ query: `OPTIMIZE TABLE trigger_dev.${table} FINAL` });
  }
  await ch.close();

  console.log(`
${SCENARIO_ERROR.name} on ${taskIdentifier} happened just now.
  fingerprint  ${SCENARIO_ERROR_FINGERPRINT}
  message      ${SCENARIO_ERROR.message}

An armed "if it recurs" watch resolves on its next check (≤5 min) with
"Error ${SCENARIO_ERROR_FINGERPRINT.slice(0, 8)} happened again". The watch only counts
occurrences after it was created, so: run this once, arm the watch, run it again.

  Errors → this group → Watch… (tick "Investigate attention outcomes" under
  Customize to get the investigation conducted for you when it fires).`);
}

async function pickErrorTask(target: Target): Promise<string> {
  const task = await prisma.backgroundWorkerTask.findFirst({
    where: { runtimeEnvironmentId: target.environmentId },
    select: { slug: true },
    orderBy: { createdAt: "desc" },
  });
  return task?.slug ?? SCENARIO_TASK_ID;
}

async function runScenario(
  target: Target,
  kind: "fail" | "succeed",
  seconds: number,
  taskFlag: string | undefined
) {
  const taskId = taskFlag ?? (kind === "fail" ? DEFAULT_FAIL_TASK : DEFAULT_SUCCEED_TASK);
  const response = await fetch(`${APP_ORIGIN}/api/v1/tasks/${taskId}/trigger`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({ payload: { seconds } }),
  }).catch((error: unknown) => {
    fail(
      `Could not reach ${APP_ORIGIN} (${error instanceof Error ? error.message : error}). ` +
        `Is the webapp running?`
    );
  });

  const body = (await response.json().catch(() => null)) as { id?: string; error?: string } | null;
  if (!response.ok || !body?.id) {
    fail(
      `Trigger failed (${response.status}): ${body?.error ?? "no run id"}\n` +
        `\`${taskId}\` has to exist in ${target.projectSlug}/${target.environmentSlug} with a\n` +
        `running \`trigger dev\`. The task source is in\n` +
        `internal-packages/dashboard-agent/GUIDEBOOK.md, or pass --task <your-task>.`
    );
  }

  console.log(`
${taskId} is running for ~${seconds}s: ${body.id}

Next, in the dashboard (${target.projectSlug}, ${target.environmentSlug}):
  Runs → ${body.id} → Watch… → Customize
    "when it finishes"  → resolves ${
      kind === "fail" ? `"Run ${body.id} failed"` : `"Run ${body.id} finished"`
    }
    "if it fails"       → ${
      kind === "fail"
        ? `resolves "Run ${body.id} failed"; tick "Investigate attention outcomes" to get the failure investigated for you`
        : `can't happen — when the run succeeds the watch resolves "Run ${body.id} succeeded" instead`
    }
  A run watch can check every minute, so pick a window with room for the sleep.`);
}

// The rollups are fed by materialized views on insert, so every table has to be named here:
// deleting from the raw landing table alone changes nothing the report reads.
const METRIC_TABLES: Array<{ table: string; timeColumn: string; envQueuedColumn?: string }> = [
  { table: "queue_metrics_raw_v1", timeColumn: "event_time", envQueuedColumn: "env_queued" },
  { table: "queue_metrics_v1", timeColumn: "bucket_start", envQueuedColumn: "max_env_queued" },
  { table: "queue_metrics_5m_v1", timeColumn: "bucket_start", envQueuedColumn: "max_env_queued" },
  { table: "env_metrics_v1", timeColumn: "bucket_start", envQueuedColumn: "max_env_queued" },
  { table: "queue_metrics_ck_v1", timeColumn: "bucket_start" },
];

/** The report reads a 1h window; 2h clears it with room for clock skew. */
const FLIP_LOOKBACK_HOURS = 2;
const LIVE_BUCKET_SEC = 10;
const BASELINE_BUCKET_SEC = 300;
const BASELINE_DAYS = 7;
const DEGRADE_WINDOW_MINUTES = 35;
const RECOVER_WINDOW_MINUTES = 10;
const DEGRADED_PENDING = 4_800;
const CALM_PENDING = 12;
const BASELINE_RUNS_PER_MIN = 6;
const DEGRADED_ARRIVALS_PER_MIN = 1_000;
const DEGRADED_STARTS_PER_MIN = 820;
const CALM_WAIT_MS = 2_500;
const DEGRADED_WAIT_MS = 16_000;
/** Above this env-level depth a bucket is a pinned one, not baseline; used to purge old pins. */
const DEGRADED_QUEUED_FLOOR = 200;
const LIVE_WAIT_SAMPLES = 4;
const BASELINE_WAIT_SAMPLES = 16;

type ChIds = { organization_id: string; project_id: string; environment_id: string };

type BucketShape = {
  envRunning: number;
  envQueued: number;
  startedPerMin: number;
  arrivalsPerMin: number;
  waitMs: number;
  throttled: boolean;
  waitSamples: number;
  bucketSec: number;
};

// The rollup reads the counters as monotonic odometers, so buckets can only be appended by an
// emitter that remembers where the last one left off.
function createBucketEmitter(ids: ChIds, queueName: string, envLimit: number, epochMs: number) {
  const odometers: Record<string, number> = { enqueue: 0, ack: 0, started: 0 };
  // Seeded from the wall clock so a later process's keys always sort after an earlier one's.
  let key = Math.floor(epochMs / 1000) * 1_000_000;
  const orderKey = () => ++key;

  const counter = (
    eventTime: string,
    op: "enqueue" | "started" | "ack",
    increment: number,
    waitMs?: number
  ): QueueMetricsRawV1Input[] => {
    const rows: QueueMetricsRawV1Input[] = [];
    // A counter's first row has to establish a zero point before any delta can be attributed.
    if (odometers[op] === 0) {
      rows.push({
        ...ids,
        queue_name: queueName,
        event_time: eventTime,
        op,
        cumulative: 0,
        order_key: orderKey(),
      });
    }
    odometers[op] += increment;
    rows.push({
      ...ids,
      queue_name: queueName,
      event_time: eventTime,
      op,
      cumulative: odometers[op],
      order_key: orderKey(),
      ...(waitMs !== undefined ? { wait_ms: waitMs } : {}),
    });
    return rows;
  };

  return (bucketMs: number, shape: BucketShape): QueueMetricsRawV1Input[] => {
    const eventTime = chDateTime(new Date(bucketMs));
    const rows: QueueMetricsRawV1Input[] = [
      {
        ...ids,
        queue_name: queueName,
        event_time: eventTime,
        op: "gauge",
        running: Math.min(envLimit, shape.envRunning),
        queued: shape.envQueued,
        queue_limit: envLimit,
        env_running: shape.envRunning,
        env_queued: shape.envQueued,
        env_limit: envLimit,
        throttled: shape.throttled && shape.envQueued > 0 ? 1 : 0,
      },
    ];
    const arrivals = Math.max(1, Math.round((shape.arrivalsPerMin * shape.bucketSec) / 60));
    const started = Math.max(1, Math.round((shape.startedPerMin * shape.bucketSec) / 60));
    rows.push(...counter(eventTime, "enqueue", arrivals));
    rows.push(...counter(eventTime, "ack", started));
    const perSample = Math.max(1, Math.round(started / shape.waitSamples));
    for (let s = 0; s < shape.waitSamples; s++) {
      rows.push(...counter(eventTime, "started", perSample, Math.round(shape.waitMs)));
    }
    return rows;
  };
}

function calmShape(bucketSec: number, waitSamples: number, progress = 1): BucketShape {
  return {
    envRunning: 6,
    // Decreasing on purpose: a rising series flags the throughput metric even at a depth of two.
    envQueued: Math.max(0, Math.round(2 * (1 - progress))),
    startedPerMin: BASELINE_RUNS_PER_MIN,
    arrivalsPerMin: BASELINE_RUNS_PER_MIN,
    waitMs: CALM_WAIT_MS,
    throttled: false,
    waitSamples,
    bucketSec,
  };
}

function pinnedShape(envLimit: number, progress: number): BucketShape {
  return {
    envRunning: envLimit,
    envQueued: Math.round(60 + (DEGRADED_PENDING - 60) * progress),
    startedPerMin: DEGRADED_STARTS_PER_MIN,
    arrivalsPerMin: DEGRADED_ARRIVALS_PER_MIN,
    waitMs: CALM_WAIT_MS + (DEGRADED_WAIT_MS - CALM_WAIT_MS) * progress,
    throttled: true,
    waitSamples: LIVE_WAIT_SAMPLES,
    bucketSec: LIVE_BUCKET_SEC,
  };
}

async function insertMetrics(ch: ClickHouse, rows: QueueMetricsRawV1Input[], nonce: string) {
  const BATCH = 25_000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const [error] = await ch.queueMetrics.insertRaw(rows.slice(i, i + BATCH), {
      params: {
        clickhouse_settings: { async_insert: 0, insert_deduplication_token: `${nonce}:${i}` },
      },
    });
    if (error) fail(`queue_metrics_raw_v1 insert failed: ${error.message}`);
  }
}

/** The rollups are AggregatingMergeTrees; a flip about to be read can't wait for merges. */
async function optimizeRollups(ch: ClickHouse) {
  const raw = rawClient(ch);
  for (const { table } of METRIC_TABLES) {
    if (table === "queue_metrics_raw_v1") continue;
    await raw.command({ query: `OPTIMIZE TABLE trigger_dev.${table} FINAL` });
  }
}

async function deleteFlipWindow(ch: ClickHouse, environmentId: string) {
  const raw = rawClient(ch);
  for (const { table, timeColumn } of METRIC_TABLES) {
    await raw.command({
      query: `ALTER TABLE trigger_dev.${table} DELETE WHERE environment_id = '${environmentId}'
              AND ${timeColumn} > now() - INTERVAL ${FLIP_LOOKBACK_HOURS} HOUR
              SETTINGS mutations_sync = 2`,
    });
  }
  await waitForMutations(raw);
}

/** Pinned buckets left outside the flip window drag the 7-day normals up to the anomaly's own. */
async function purgePinnedBaseline(ch: ClickHouse, environmentId: string) {
  const raw = rawClient(ch);
  for (const { table, timeColumn, envQueuedColumn } of METRIC_TABLES) {
    if (!envQueuedColumn) continue;
    await raw.command({
      query: `ALTER TABLE trigger_dev.${table} DELETE WHERE environment_id = '${environmentId}'
              AND ${timeColumn} <= now() - INTERVAL ${FLIP_LOOKBACK_HOURS} HOUR
              AND ${envQueuedColumn} >= ${DEGRADED_QUEUED_FLOOR}
              SETTINGS mutations_sync = 2`,
    });
  }
  await waitForMutations(raw);
}

/** Written once: without a baseline there is no "normal" for the report to be anomalous against. */
async function ensureBaseline(ch: ClickHouse, target: Target, queueName: string, ids: ChIds) {
  const raw = rawClient(ch);
  const result = await raw.query({
    query: `SELECT count() AS buckets FROM trigger_dev.queue_metrics_v1
            WHERE environment_id = '${target.environmentId}'
              AND bucket_start <= now() - INTERVAL ${FLIP_LOOKBACK_HOURS} HOUR`,
    format: "JSONEachRow",
  });
  const rows = (await result.json()) as Array<{ buckets: string | number }>;
  if (Number(rows[0]?.buckets ?? 0) > 500) return;

  const now = Date.now();
  const emit = createBucketEmitter(ids, queueName, target.envConcurrencyLimit, now);
  const buckets = (BASELINE_DAYS * 24 * 3600) / BASELINE_BUCKET_SEC;
  const start =
    Math.floor((now - BASELINE_DAYS * 24 * 3600_000) / 1000 / BASELINE_BUCKET_SEC) *
    BASELINE_BUCKET_SEC *
    1000;
  const metricRows: QueueMetricsRawV1Input[] = [];
  for (let b = 0; b < buckets; b++) {
    const bucketMs = start + b * BASELINE_BUCKET_SEC * 1000;
    if (bucketMs >= now - FLIP_LOOKBACK_HOURS * 3600_000) break;
    metricRows.push(...emit(bucketMs, calmShape(BASELINE_BUCKET_SEC, BASELINE_WAIT_SAMPLES, 0.5)));
  }
  await insertMetrics(ch, metricRows, `scenario-baseline-${now}`);
  console.log(`Wrote a ${BASELINE_DAYS}-day calm baseline (${metricRows.length} rows).`);
}

async function writeLiveWindow(
  ch: ClickHouse,
  target: Target,
  queueName: string,
  ids: ChIds,
  mode: "degraded" | "calm"
) {
  const now = Date.now();
  const emit = createBucketEmitter(ids, queueName, target.envConcurrencyLimit, now);
  const minutes = mode === "calm" ? RECOVER_WINDOW_MINUTES : DEGRADE_WINDOW_MINUTES;
  const buckets = Math.round((minutes * 60) / LIVE_BUCKET_SEC);
  const nowBucket = Math.floor(now / 1000 / LIVE_BUCKET_SEC) * LIVE_BUCKET_SEC * 1000;
  const rows: QueueMetricsRawV1Input[] = [];
  for (let b = 0; b < buckets; b++) {
    const bucketMs = nowBucket - (buckets - 1 - b) * LIVE_BUCKET_SEC * 1000;
    const progress = buckets === 1 ? 1 : b / (buckets - 1);
    rows.push(
      ...emit(
        bucketMs,
        mode === "calm"
          ? calmShape(LIVE_BUCKET_SEC, LIVE_WAIT_SAMPLES, progress)
          : pinnedShape(target.envConcurrencyLimit, progress)
      )
    );
  }
  await insertMetrics(ch, rows, `scenario-${mode}-${now}`);
  console.log(`Wrote ${minutes}m of ${mode} buckets (${rows.length} rows).`);
}

async function healthFlip(target: Target, mode: "degrade" | "recover", queueFlag?: string) {
  const queueName = await pickMetricsQueue(target, queueFlag);
  const ids: ChIds = {
    organization_id: target.organizationId,
    project_id: target.projectId,
    environment_id: target.environmentId,
  };
  const ch = clickhouse();

  if (mode === "degrade") {
    // Merge first: a DELETE on `max_env_queued` only sees per-part values, so an unmerged
    // pinned bucket would survive the purge.
    await optimizeRollups(ch);
    await purgePinnedBaseline(ch, target.environmentId);
  }
  await ensureBaseline(ch, target, queueName, ids);
  await deleteFlipWindow(ch, target.environmentId);
  await writeLiveWindow(ch, target, queueName, ids, mode === "degrade" ? "degraded" : "calm");
  await optimizeRollups(ch);
  await ch.close();

  const depth = mode === "degrade" ? DEGRADED_PENDING : CALM_PENDING;
  await stageDepth(target, queueName, depth);

  console.log(
    mode === "degrade"
      ? `\n${target.environmentSlug} is pinned at its concurrency ceiling with ${depth} runs waiting.
Ask the agent "is anything wrong right now?" for the degraded report card.`
      : `\n${target.environmentSlug} is calm again (${depth} runs waiting).
An armed "when it recovers" watch resolves on its next check (≤5 min) with "Health recovered".`
  );
}

function printHelp() {
  console.log(`Watch / Investigate scenarios, against any local project and environment.

Usage: pnpm --filter webapp run scenarios:watch -- <verb> [args] --project <ref-or-slug> [--env dev]

Verbs:
  queue:fill <queue> <depth> [--age-min N]
                    stage <depth> runs on the queue (and the env-level key).
                    --age-min backdates the oldest one, for the wait-limit watch.
  queue:grow <queue> <depth>
                    same thing, named for the "if it grows" watch.
  queue:drain <queue>
                    empty the queue. Arm the drain watch first.
  error:recur [--task <id>]
                    one failed run for the kit's fingerprint. Run it once to
                    create the group, arm the watch, run it again to recur.
  run:fail [sec] [--task <id>]
                    trigger ${DEFAULT_FAIL_TASK} (default ${DEFAULT_RUN_SECONDS}s).
  run:succeed [sec] [--task <id>]
                    trigger ${DEFAULT_SUCCEED_TASK} (default ${DEFAULT_RUN_SECONDS}s).
  health:degrade [--queue <name>]
                    the health report goes critical.
  health:recover [--queue <name>]
                    the health report goes ok.

Flags:
  --project <ref-or-slug>  the local project to target (required).
  --env <dev|staging|prod|slug>   default dev.

Prerequisites: \`pnpm run docker\`, migrations, a running webapp, ANTHROPIC_API_KEY
exported — and, for the run verbs, a \`trigger dev\` with the named task.

Walkthroughs: internal-packages/dashboard-agent/GUIDEBOOK.md`);
}

async function main() {
  const { positional, flags } = parseFlags(process.argv.slice(2));
  const verb = positional[0];
  if (!verb || flags.help === "true") {
    printHelp();
    process.exit(0);
  }

  const requireQueueName = () => positional[1] ?? fail(`${verb} needs a queue name.`);
  const requireDepth = () => {
    const depth = Number(positional[2]);
    if (!Number.isInteger(depth) || depth < 0) {
      fail(`${verb} needs a whole, non-negative depth, got: ${positional[2]}`);
    }
    return depth;
  };
  const seconds = () => {
    const value = Number(positional[1] ?? DEFAULT_RUN_SECONDS);
    if (!Number.isFinite(value) || value <= 0)
      fail(`Seconds must be positive, got: ${positional[1]}`);
    return value;
  };
  const ageMinutes = () => {
    const raw = flags["age-min"];
    if (raw === undefined) return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) fail(`--age-min must be non-negative, got: ${raw}`);
    return value;
  };

  const target = await resolveTarget(flags.project, flags.env);

  switch (verb) {
    case "queue:fill":
    case "queue:grow":
      await queueFill(target, requireQueueName(), requireDepth(), ageMinutes());
      break;
    case "queue:drain":
      await queueDrain(target, requireQueueName());
      break;
    case "error:recur":
      await errorRecur(target, flags.task);
      break;
    case "run:fail":
      await runScenario(target, "fail", seconds(), flags.task);
      break;
    case "run:succeed":
      await runScenario(target, "succeed", seconds(), flags.task);
      break;
    case "health:degrade":
      await healthFlip(target, "degrade", flags.queue);
      break;
    case "health:recover":
      await healthFlip(target, "recover", flags.queue);
      break;
    default:
      console.error(`Unknown verb: ${verb}\n`);
      printHelp();
      process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
