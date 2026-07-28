/**
 * Seeds the `agent-examples` project: the dashboard-agent example conversations
 * as real stored chats over real data.
 *
 * Demo mode renders canned fixtures with no backend. This seeder does the
 * opposite — it creates an isolated project whose runs, queues, deployment,
 * error group and metrics actually exist, then stores the same conversations as
 * transcripts in the agent's own datastore. The panel loads them through the
 * production path, and every id, queue name, version and citation in them
 * resolves to a live dashboard page.
 *
 *   pnpm --filter webapp run db:seed:agent-examples
 *   pnpm --filter webapp run db:seed:agent-examples -- --scale 0.1   # fast iteration
 *
 * Re-runnable: the project is identified by a fixed external ref, and every run
 * of the seeder wipes the data it owns (both environments' runs/queues/metrics
 * and the chats it created) before writing it again. Nothing outside the project
 * is touched.
 *
 * Both prod and dev get the world, because dev is the environment the dashboard
 * opens on by default: seeded prod-only, the project looks empty on arrival and
 * the org-scoped chats look like the only thing in it. Each environment is
 * generated separately rather than copied, so no two runs share a friendly id.
 * Dev carries a fraction of prod's volume — it has to look alive, not identical.
 * The transcripts are unchanged: they're org-scoped and their citations point at
 * prod's entities.
 *
 * The story, one set of numbers everywhere: the environment has been pinned at
 * its concurrency ceiling for the last ~38 minutes while work keeps arriving, so
 * flow is critical and execution is fine. `send-order-receipt` is failing on a
 * provider rate limit; one run is the centre of the investigation, one is still
 * queued, one is running far past its usual duration, and one failed the same
 * way at the start of the burst.
 *
 * Two things to know when reading the numbers back:
 *
 * - The stored report card is fetched live from the running dev server, and the
 *   report's 7-day baselines are cached in that process for 5 minutes. Seeding
 *   twice inside that window stores a card whose "normal" columns still describe
 *   the previous seed. Wait it out, or re-run once more, for clean baselines.
 * - The 7-day run baseline is deliberately thin (a few runs a minute). Ratio and
 *   quantile normals — failure rate, the latency and duration p95s — come out
 *   right; the per-minute *rate* normals read low, because matching the live
 *   window's arrival rate across a week would mean millions of rows.
 */
import { ClickHouse, TASK_RUN_COLUMNS } from "@internal/clickhouse";
import type { QueueMetricsRawV1Input, TaskEventV2Input } from "@internal/clickhouse";
import { createChat, createDashboardAgentDb } from "@internal/dashboard-agent-db";
import { randomUUID } from "node:crypto";
import { nanoid } from "nanoid";
import {
  buildAgentExampleChats,
  SKIPPED_DEMO_CHATS,
  type AgentExamplesWorld,
} from "./seed-agent-examples-chats.mjs";
// oxlint-disable import/default -- deliberate CommonJS interop, see below.
// The webapp's own modules come in through their default binding on purpose.
// This entry has to be ESM (`@internal/clickhouse` and the agent datastore are
// ESM-only packages), but tsx compiles the app's `.ts` files to CommonJS — the
// app is not an ESM package — and an ESM importer can only reach a CommonJS
// module's exports through `default`. A named import of one fails to link at
// runtime, which is what breaks the two older `.mts` seeders today.
import dbServer from "./app/db.server";
import envServer from "./app/env.server";
import organizationServer from "./app/models/organization.server";
import projectServer from "./app/models/project.server";
import healthReport from "./app/presenters/v3/reports/health/health";
import errorFingerprinting from "./app/utils/errorFingerprinting";
import eventCommon from "./app/v3/eventRepository/common.server";
import friendlyIdentifiers from "./app/v3/friendlyIdentifiers";
import type { HealthInput } from "./app/presenters/v3/reports/health/health-core";

const { prisma } = dbServer;
const { env } = envServer;
const { createOrganization } = organizationServer;
const { createProject } = projectServer;
const { interpret } = healthReport;
const { calculateErrorFingerprint } = errorFingerprinting;
const { generateFriendlyId } = friendlyIdentifiers;
const { generateTraceId, generateSpanId } = eventCommon;

// ---------------------------------------------------------------------------
// Identity. Fixed so re-seeding finds its own rows instead of making new ones.
// ---------------------------------------------------------------------------

const ORG_TITLE = "Agent Examples";
const PROJECT_NAME = "agent-examples";
const PROJECT_REF = "proj_agentexamplesseed01";
/**
 * Both environments get the same world. Dev matters because it's the one the
 * dashboard opens on by default — seeded prod-only, the project looks empty and
 * the org-scoped chats look like the only thing there is.
 */
const ENV_TYPES = ["PRODUCTION", "DEVELOPMENT"] as const;
type SeededEnvType = (typeof ENV_TYPES)[number];
/** Dev only has to look alive, so it carries a fraction of prod's volume. */
const DEV_SCALE_FACTOR = 0.3;
const DEPLOYMENT_VERSION = "20260726.4";
const GIT_SHA = "9f3c1a2b7d4e6058ab1c2d3e4f5061728394a5b6";
const SOURCE_PATH = "src/trigger/sendOrderReceipt.ts";
/** Marks the chats this seeder owns, so a re-seed replaces exactly those. */
const CHAT_ID_PREFIX = "chat_agentex_";

const TASK_ID = "send-order-receipt";
const SLOW_TASK_ID = "generate-monthly-report";
const QUEUE = "email-sends";
const BACKLOG_QUEUE = "reports-heavy";
const HEALTHY_QUEUE = "webhooks";

/** The story's numbers. Prose, cards and seeded data all read from here. */
const STORY = {
  envConcurrencyLimit: 50,
  /** Minutes of the last hour spent pinned at the ceiling. */
  pinnedMinutes: 38,
  /** Env-level pending depth at the end of the window. */
  pending: 4_812,
  worstQueueShare: 0.71,
  triggeredPerMin: 1_000,
  donePerMin: 820,
  /** Failure ratio inside the live window: bad enough to notice, not the cause. */
  failureRate: 0.006,
  /** How long the backlog takes to clear on its own, in minutes. */
  drainMinutes: 27,
  /** Baseline (7d) rates, calm. */
  baselineRunsPerMin: 6,
  baselineFailureRate: 0.005,
  /** Median wait/duration, chosen so the p95s land on the story's figures. */
  calmWaitMedianMs: 2_537,
  pinnedWaitMedianMs: 16_044,
  durationMedianMs: 1_567,
  waitSigma: 0.6,
} as const;

const QUEUE_LIMITS: Record<string, number> = {
  [QUEUE]: 50,
  [BACKLOG_QUEUE]: 20,
  [HEALTHY_QUEUE]: 15,
};
/** How the env-level pending depth divides across the queues. */
const QUEUE_PENDING_SHARE: Record<string, number> = {
  [QUEUE]: STORY.worstQueueShare,
  [BACKLOG_QUEUE]: 0.19,
  [HEALTHY_QUEUE]: 0.1,
};

const LIVE_WINDOW_MIN = 60;
const BUCKET_SEC = 10;
const BASELINE_DAYS = 7;
const BASELINE_BUCKET_SEC = 300;
const LIVE_WAIT_SAMPLES = 4;
/**
 * The 7-day baseline needs enough wait samples that the live spike sits below
 * the 95th percentile of the two windows combined — otherwise the report reads
 * its own anomaly as the normal and the latency delta collapses to 1x. 16 per
 * 5-minute bucket puts the spike at ~4% of the samples.
 */
const BASELINE_WAIT_SAMPLES = 16;

// ---------------------------------------------------------------------------
// Deterministic RNG, so two runs of the seeder produce the same world.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function lognormal(medianMs: number, sigma: number, rng: () => number): number {
  return Math.max(1, Math.round(Math.exp(Math.log(medianMs) + sigma * standardNormal(rng))));
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function chDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function clock(date: Date): string {
  return date.toISOString().slice(11, 16);
}

/** ClickHouse `start_time` is seconds with 9 decimal places. */
function chStartTime(ms: number): string {
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, "0")}000000`;
}

function parseArgs(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// ClickHouse
// ---------------------------------------------------------------------------

function clickhouse(): ClickHouse {
  const url = process.env.CLICKHOUSE_URL ?? process.env.EVENTS_CLICKHOUSE_URL;
  if (!url) {
    console.error("CLICKHOUSE_URL not set");
    process.exit(1);
  }
  const parsed = new URL(url);
  // This script deletes rows, so refuse anything but a local instance. Never echo
  // the URL — it carries credentials.
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (!localHosts.has(parsed.hostname)) {
    console.error(`Refusing to run against a non-local ClickHouse host: ${parsed.hostname}`);
    process.exit(1);
  }
  parsed.searchParams.delete("secure");
  return new ClickHouse({ url: parsed.toString(), name: "agent-examples-seeder" });
}

type RawCommand = { command: (a: { query: string }) => Promise<unknown> };

function rawClient(ch: ClickHouse): RawCommand {
  return (ch.writer as unknown as { client: RawCommand }).client;
}

async function resetClickhouse(ch: ClickHouse, environmentId: string, label: string) {
  const raw = rawClient(ch);
  const tables = [
    "task_runs_v2",
    "task_events_v2",
    "queue_metrics_raw_v1",
    "queue_metrics_v1",
    "queue_metrics_5m_v1",
    "env_metrics_v1",
    "queue_metrics_ck_v1",
    "errors_v1",
    "error_occurrences_v1",
  ];
  for (const table of tables) {
    // `mutations_sync = 2` makes the delete finish before the insert that follows
    // it. Left asynchronous, a re-seed races its own predecessor and leaves a
    // second copy of the cast behind — two runs claiming to be the slow one.
    await raw.command({
      query: `DELETE FROM trigger_dev.${table} WHERE environment_id = '${environmentId}' SETTINGS mutations_sync = 2`,
    });
  }
  console.log(`[${label}] cleared ClickHouse rows for environment ${environmentId}`);
  // A running dev server replicates this project's Postgres runs into
  // `task_runs_v2` itself, so after a re-seed the table also holds one tombstone
  // (`_is_deleted = 1`) per run the reset removed. A raw `count()` sees them; every
  // read path is `FINAL` with `_is_deleted = 0`, so the dashboard does not.
}

// ---------------------------------------------------------------------------
// Postgres: org, project, environment, worker, deployment, queues
// ---------------------------------------------------------------------------

async function seedPostgresShell(userId: string) {
  let org = await prisma.organization.findFirst({
    where: { title: ORG_TITLE, members: { some: { userId } } },
  });
  if (!org) {
    org = await createOrganization({ title: ORG_TITLE, userId, companySize: "1-10" });
  }
  // The panel is flag-gated. Turning the flag on for this org alone means the
  // examples are reviewable without flipping the global default.
  org = await prisma.organization.update({
    where: { id: org.id },
    data: {
      // Project creation refuses an org that hasn't picked a plan, and a seeder
      // has no checkout flow to go through.
      isActivated: true,
      featureFlags: {
        ...((org.featureFlags as Record<string, unknown>) ?? {}),
        hasDashboardAgentAccess: true,
      },
    },
  });

  let project = await prisma.project.findFirst({
    where: { externalRef: PROJECT_REF },
  });
  if (!project) {
    project = await createProject({
      organizationSlug: org.slug,
      name: PROJECT_NAME,
      userId,
      version: "v3",
    });
    project = await prisma.project.update({
      where: { id: project.id },
      data: { externalRef: PROJECT_REF },
    });
  }
  project = await prisma.project.update({
    where: { id: project.id },
    data: { engine: "V2" },
  });

  // Ordered as ENV_TYPES is: prod first, because prod's cast is the one the
  // transcripts cite.
  const environments = [];
  for (const type of ENV_TYPES) {
    const environment = await prisma.runtimeEnvironment.findFirst({
      where: { projectId: project.id, type },
    });
    if (!environment) {
      console.error(`No ${type} environment on project ${project.slug}.`);
      process.exit(1);
    }
    // The report reads the ceiling from ClickHouse; keeping Postgres in step means
    // the queues page and the report can't disagree.
    await prisma.runtimeEnvironment.update({
      where: { id: environment.id },
      data: { maximumConcurrencyLimit: STORY.envConcurrencyLimit },
    });
    environments.push({
      id: environment.id,
      slug: environment.slug,
      apiKey: environment.apiKey,
      type: type as SeededEnvType,
    });
  }

  return { org, project, environments };
}

async function resetPostgresData(environmentId: string, projectId: string, label: string) {
  await prisma.taskRun.deleteMany({ where: { runtimeEnvironmentId: environmentId } });
  await prisma.taskQueue.deleteMany({ where: { runtimeEnvironmentId: environmentId } });
  await prisma.workerDeploymentPromotion.deleteMany({ where: { environmentId } });
  await prisma.workerDeployment.deleteMany({ where: { environmentId } });
  await prisma.backgroundWorker.deleteMany({
    where: { runtimeEnvironmentId: environmentId, projectId },
  });
  console.log(`[${label}] cleared this project's runs, queues, worker and deployment`);
}

async function seedWorkerAndDeployment(
  projectId: string,
  environmentId: string,
  userId: string,
  deployedAt: Date
) {
  const worker = await prisma.backgroundWorker.create({
    data: {
      friendlyId: generateFriendlyId("worker"),
      engine: "V2",
      contentHash: `agent-examples-${DEPLOYMENT_VERSION}`,
      sdkVersion: "4.0.0",
      cliVersion: "4.0.0",
      projectId,
      runtimeEnvironmentId: environmentId,
      version: DEPLOYMENT_VERSION,
      metadata: {},
    },
  });

  const tasks = [
    { slug: TASK_ID, filePath: SOURCE_PATH, exportName: "sendOrderReceipt", queue: QUEUE },
    {
      slug: SLOW_TASK_ID,
      filePath: "src/trigger/generateMonthlyReport.ts",
      exportName: "generateMonthlyReport",
      queue: BACKLOG_QUEUE,
    },
    {
      slug: "sync-inventory",
      filePath: "src/trigger/syncInventory.ts",
      exportName: "syncInventory",
      queue: HEALTHY_QUEUE,
    },
    {
      slug: "send-welcome-email",
      filePath: "src/trigger/sendWelcomeEmail.ts",
      exportName: "sendWelcomeEmail",
      queue: QUEUE,
    },
  ];
  for (const task of tasks) {
    await prisma.backgroundWorkerTask.create({
      data: {
        friendlyId: generateFriendlyId("task"),
        slug: task.slug,
        filePath: task.filePath,
        exportName: task.exportName,
        workerId: worker.id,
        projectId,
        runtimeEnvironmentId: environmentId,
        queueConfig: { name: task.queue },
      },
    });
  }

  const deployment = await prisma.workerDeployment.create({
    data: {
      friendlyId: generateFriendlyId("deployment"),
      contentHash: worker.contentHash,
      shortCode: nanoid(8),
      version: DEPLOYMENT_VERSION,
      status: "DEPLOYED",
      type: "MANAGED",
      projectId,
      environmentId,
      workerId: worker.id,
      triggeredById: userId,
      triggeredVia: "GIT_HUB",
      commitSHA: GIT_SHA,
      imageReference: `local.registry/agent-examples:${DEPLOYMENT_VERSION}`,
      startedAt: new Date(deployedAt.getTime() - 4 * 60_000),
      builtAt: new Date(deployedAt.getTime() - 60_000),
      deployedAt,
      // GitMeta — this is what a version-correlation answer reads back.
      git: {
        commitSha: GIT_SHA,
        commitMessage: "Retry sendOrderReceipt three times on provider errors",
        commitAuthorName: "Sam Rivers",
        remoteUrl: "https://github.com/acme/storefront",
        branchName: "main",
        pullRequestNumber: 482,
        pullRequestTitle: "Add retries to the receipt sender",
        dirty: true,
      },
    },
  });
  await prisma.workerDeploymentPromotion.create({
    data: { label: "current", deploymentId: deployment.id, environmentId },
  });

  return { worker, deployment };
}

async function seedQueues(projectId: string, environmentId: string, label: string) {
  for (const [name, concurrencyLimit] of Object.entries(QUEUE_LIMITS)) {
    await prisma.taskQueue.create({
      data: {
        friendlyId: generateFriendlyId("queue"),
        version: "V2",
        name,
        orderableName: name,
        concurrencyLimit,
        runtimeEnvironmentId: environmentId,
        projectId,
        type: "NAMED",
      },
    });
  }
  console.log(`[${label}] created ${Object.keys(QUEUE_LIMITS).length} task queues`);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const PROVIDER_ERROR = {
  type: "BUILT_IN_ERROR",
  name: "ProviderError",
  message: "429 Too Many Requests (rate_limit_exceeded)",
  stackTrace: `ProviderError: 429 Too Many Requests (rate_limit_exceeded)
    at sendEmail (${SOURCE_PATH}:31:11)
    at run (${SOURCE_PATH}:18:5)`,
};

const ERROR_FINGERPRINT = calculateErrorFingerprint(PROVIDER_ERROR);

type ChIds = { organization_id: string; project_id: string; environment_id: string };

type RunSpec = {
  friendlyId: string;
  taskIdentifier: string;
  queue: string;
  status: string;
  createdAt: Date;
  queuedAt: Date;
  startedAt?: Date;
  executedAt?: Date;
  completedAt?: Date;
  attemptNumber?: number;
  error?: unknown;
  payload: string;
  spanId: string;
  traceId: string;
  machinePreset: string;
  usageDurationMs: number;
  tags: string[];
};

/**
 * A Postgres-side run id for the volume rows, which have no Postgres row of
 * their own. Only shape and uniqueness matter — nothing joins on it.
 */
function syntheticRunId(): string {
  return randomUUID().replaceAll("-", "");
}

/** The four runs the conversations cite, plus the recent activity around them. */
function buildCastRuns(now: number, rng: () => number) {
  const spikeStart = now - STORY.pinnedMinutes * 60_000;

  const failedCreated = new Date(now - 5 * 60_000);
  const failed: RunSpec = {
    friendlyId: generateFriendlyId("run"),
    taskIdentifier: TASK_ID,
    queue: QUEUE,
    status: "COMPLETED_WITH_ERRORS",
    createdAt: failedCreated,
    queuedAt: failedCreated,
    startedAt: new Date(failedCreated.getTime() + 41_000),
    executedAt: new Date(failedCreated.getTime() + 41_200),
    completedAt: new Date(failedCreated.getTime() + 60_600),
    attemptNumber: 3,
    error: PROVIDER_ERROR,
    payload: JSON.stringify({ orderId: "ord_9f31c8", email: "ada@example.com" }),
    spanId: generateSpanId(),
    traceId: generateTraceId(),
    machinePreset: "small-1x",
    usageDurationMs: 19_400,
    tags: ["order:ord_9f31c8"],
  };

  const waitingCreated = new Date(now - 90_000);
  const waiting: RunSpec = {
    friendlyId: generateFriendlyId("run"),
    taskIdentifier: TASK_ID,
    queue: QUEUE,
    status: "PENDING",
    createdAt: waitingCreated,
    queuedAt: waitingCreated,
    payload: JSON.stringify({ orderId: "ord_a71b04", email: "grace@example.com" }),
    spanId: generateSpanId(),
    traceId: generateTraceId(),
    machinePreset: "small-1x",
    usageDurationMs: 0,
    tags: ["order:ord_a71b04"],
  };

  const slowCreated = new Date(now - 24 * 60_000 - 2_000);
  const slow: RunSpec = {
    friendlyId: generateFriendlyId("run"),
    taskIdentifier: SLOW_TASK_ID,
    queue: BACKLOG_QUEUE,
    status: "EXECUTING",
    createdAt: slowCreated,
    queuedAt: slowCreated,
    startedAt: new Date(slowCreated.getTime() + 40),
    executedAt: new Date(slowCreated.getTime() + 240),
    attemptNumber: 1,
    payload: JSON.stringify({ month: "2026-06", segments: 41 }),
    spanId: generateSpanId(),
    traceId: generateTraceId(),
    machinePreset: "large-1x",
    usageDurationMs: 1_452_000,
    tags: ["report:monthly"],
  };

  const priorCreated = new Date(spikeStart + 20_000);
  const prior: RunSpec = {
    friendlyId: generateFriendlyId("run"),
    taskIdentifier: TASK_ID,
    queue: QUEUE,
    status: "COMPLETED_WITH_ERRORS",
    createdAt: priorCreated,
    queuedAt: priorCreated,
    startedAt: new Date(priorCreated.getTime() + 9_000),
    executedAt: new Date(priorCreated.getTime() + 9_200),
    completedAt: new Date(priorCreated.getTime() + 28_500),
    attemptNumber: 3,
    error: PROVIDER_ERROR,
    payload: JSON.stringify({ orderId: "ord_4419bb", email: "linus@example.com" }),
    spanId: generateSpanId(),
    traceId: generateTraceId(),
    machinePreset: "small-1x",
    usageDurationMs: 19_300,
    tags: ["order:ord_4419bb"],
  };

  // A believable recent list around the cast: mostly fine, a couple failing the
  // same way, a few still queued behind the limit.
  const background: RunSpec[] = [];
  const backgroundTasks = [
    { id: TASK_ID, queue: QUEUE },
    { id: "send-welcome-email", queue: QUEUE },
    { id: "sync-inventory", queue: HEALTHY_QUEUE },
  ];
  for (let i = 0; i < 24; i++) {
    const task = backgroundTasks[i % backgroundTasks.length];
    const created = new Date(now - 150_000 + i * 5_500);
    const roll = rng();
    const wait = lognormal(STORY.pinnedWaitMedianMs, STORY.waitSigma, rng);
    const duration = lognormal(STORY.durationMedianMs, STORY.waitSigma, rng);
    const failing = roll < 0.12 && task.id === TASK_ID;
    const queued = roll > 0.86;
    background.push({
      friendlyId: generateFriendlyId("run"),
      taskIdentifier: task.id,
      queue: task.queue,
      status: queued ? "PENDING" : failing ? "COMPLETED_WITH_ERRORS" : "COMPLETED_SUCCESSFULLY",
      createdAt: created,
      queuedAt: created,
      ...(queued
        ? {}
        : {
            startedAt: new Date(created.getTime() + wait),
            executedAt: new Date(created.getTime() + wait + 200),
            completedAt: new Date(created.getTime() + wait + 200 + duration),
          }),
      attemptNumber: queued ? undefined : failing ? 3 : 1,
      ...(failing ? { error: PROVIDER_ERROR } : {}),
      payload: JSON.stringify({ i }),
      spanId: generateSpanId(),
      traceId: generateTraceId(),
      machinePreset: "small-1x",
      usageDurationMs: queued ? 0 : duration,
      tags: [],
    });
  }

  return { failed, waiting, slow, prior, background };
}

async function insertPostgresRuns(
  specs: RunSpec[],
  ids: {
    projectId: string;
    environmentId: string;
    organizationId: string;
    workerId: string;
    environmentType: SeededEnvType;
  }
): Promise<Map<string, string>> {
  const runIdByFriendlyId = new Map<string, string>();
  let number = 1;
  for (const spec of specs) {
    const run = await prisma.taskRun.create({
      data: {
        number: number++,
        friendlyId: spec.friendlyId,
        engine: "V2",
        status: spec.status as never,
        taskIdentifier: spec.taskIdentifier,
        payload: spec.payload,
        payloadType: "application/json",
        traceId: spec.traceId,
        spanId: spec.spanId,
        runtimeEnvironmentId: ids.environmentId,
        environmentType: ids.environmentType,
        projectId: ids.projectId,
        organizationId: ids.organizationId,
        queue: spec.queue,
        workerQueue: "main",
        lockedToVersionId: ids.workerId,
        taskVersion: DEPLOYMENT_VERSION,
        sdkVersion: "4.0.0",
        cliVersion: "4.0.0",
        machinePreset: spec.machinePreset,
        attemptNumber: spec.attemptNumber ?? null,
        createdAt: spec.createdAt,
        queuedAt: spec.queuedAt,
        queueTimestamp: spec.queuedAt,
        startedAt: spec.startedAt ?? null,
        executedAt: spec.executedAt ?? null,
        completedAt: spec.completedAt ?? null,
        usageDurationMs: spec.usageDurationMs,
        maxAttempts: 3,
        runTags: spec.tags,
        error: (spec.error ?? null) as never,
        taskEventStore: "clickhouse_v2",
      },
    });
    runIdByFriendlyId.set(spec.friendlyId, run.id);
  }
  return runIdByFriendlyId;
}

/** One `task_runs_v2` row, as a positional array in `TASK_RUN_COLUMNS` order. */
function taskRunRow(
  spec: RunSpec,
  runId: string,
  ids: ChIds,
  version: string,
  environmentType: SeededEnvType
): ReadonlyArray<unknown> {
  const failed = ["COMPLETED_WITH_ERRORS", "SYSTEM_FAILURE", "CRASHED", "TIMED_OUT"].includes(
    spec.status
  );
  const row: Record<string, unknown> = {
    environment_id: ids.environment_id,
    organization_id: ids.organization_id,
    project_id: ids.project_id,
    run_id: runId,
    updated_at: spec.createdAt.getTime(),
    created_at: spec.createdAt.getTime(),
    status: spec.status,
    environment_type: environmentType,
    friendly_id: spec.friendlyId,
    attempt: spec.attemptNumber ?? 1,
    engine: "V2",
    task_identifier: spec.taskIdentifier,
    queue: spec.queue,
    schedule_id: "",
    batch_id: "",
    completed_at: spec.completedAt?.getTime() ?? null,
    started_at: spec.startedAt?.getTime() ?? null,
    executed_at: spec.executedAt?.getTime() ?? null,
    delay_until: null,
    queued_at: spec.queuedAt.getTime(),
    expired_at: null,
    usage_duration_ms: spec.usageDurationMs,
    cost_in_cents: 0,
    base_cost_in_cents: 0,
    output: null,
    // The replication path wraps the run error in `{ data }`; the error-group
    // materialized views read `error.data.name` / `.message` / `.stackTrace`.
    error: spec.error ? { data: spec.error } : null,
    error_fingerprint: failed ? ERROR_FINGERPRINT : "",
    tags: spec.tags,
    task_version: DEPLOYMENT_VERSION,
    sdk_version: "4.0.0",
    cli_version: "4.0.0",
    machine_preset: spec.machinePreset,
    root_run_id: "",
    parent_run_id: "",
    depth: 0,
    span_id: spec.spanId,
    trace_id: spec.traceId,
    idempotency_key: "",
    idempotency_key_user: "",
    idempotency_key_scope: "",
    expiration_ttl: "",
    is_test: false,
    _version: version,
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
  return TASK_RUN_COLUMNS.map((column) => row[column]);
}

/**
 * The volume behind the report: an hour at the story's arrival rate, plus a calm
 * 7-day baseline.
 *
 * These rows exist in ClickHouse only. Postgres rows for a million-row backlog
 * would make the seeder unusable, and nothing in the transcripts cites them —
 * the runs every conversation links to are the cast, which do have Postgres rows
 * and spans.
 */
function buildBulkRuns(now: number, scale: number, rng: () => number): RunSpec[] {
  const specs: RunSpec[] = [];

  const emit = (
    created: number,
    task: string,
    queue: string,
    status: string,
    waitMs: number,
    durationMs: number,
    failing: boolean
  ) => {
    const startedAt = new Date(created + waitMs);
    const finished = status !== "PENDING";
    specs.push({
      friendlyId: generateFriendlyId("run"),
      taskIdentifier: task,
      queue,
      status,
      createdAt: new Date(created),
      queuedAt: new Date(created),
      ...(finished
        ? {
            startedAt,
            executedAt: new Date(startedAt.getTime() + 200),
            completedAt: new Date(startedAt.getTime() + 200 + durationMs),
          }
        : {}),
      attemptNumber: finished ? (failing ? 3 : 1) : undefined,
      ...(failing ? { error: PROVIDER_ERROR } : {}),
      payload: "{}",
      spanId: generateSpanId(),
      traceId: generateTraceId(),
      machinePreset: "small-1x",
      usageDurationMs: finished ? durationMs : 0,
      tags: [],
    });
  };

  const tasks: Array<{ id: string; queue: string }> = [
    { id: TASK_ID, queue: QUEUE },
    { id: "send-welcome-email", queue: QUEUE },
    { id: "sync-inventory", queue: HEALTHY_QUEUE },
    { id: SLOW_TASK_ID, queue: BACKLOG_QUEUE },
  ];

  // Live window. Arrivals at the spike rate; completions at the drain rate, so
  // the remainder is the backlog the report attributes to the env limit.
  const liveEnd = now - 3 * 60_000;
  const perMin = Math.max(1, Math.round(STORY.triggeredPerMin * scale));
  const donePerMin = Math.round(perMin * (STORY.donePerMin / STORY.triggeredPerMin));
  const spikeStart = now - STORY.pinnedMinutes * 60_000;
  for (let minute = 0; minute < LIVE_WINDOW_MIN; minute++) {
    const minuteStart = liveEnd - (LIVE_WINDOW_MIN - minute) * 60_000;
    const pinned = minuteStart >= spikeStart;
    const waitMedian = pinned
      ? STORY.calmWaitMedianMs +
        ((STORY.pinnedWaitMedianMs - STORY.calmWaitMedianMs) * (minuteStart - spikeStart)) /
          (STORY.pinnedMinutes * 60_000)
      : STORY.calmWaitMedianMs;
    const arrivals = pinned ? perMin : Math.round(perMin * 0.82);
    const completions = Math.min(arrivals, donePerMin);
    for (let i = 0; i < arrivals; i++) {
      const created = minuteStart + Math.floor((i / arrivals) * 60_000);
      const finished = i < completions;
      const failing = finished && rng() < STORY.failureRate;
      // Every failure is the rate-limited receipt sender, so the error page has
      // one group and the failure attribution has one task to name.
      const task = failing ? { id: TASK_ID, queue: QUEUE } : tasks[i % tasks.length];
      emit(
        created,
        task.id,
        task.queue,
        finished ? (failing ? "COMPLETED_WITH_ERRORS" : "COMPLETED_SUCCESSFULLY") : "PENDING",
        lognormal(waitMedian, STORY.waitSigma, rng),
        lognormal(STORY.durationMedianMs, STORY.waitSigma, rng),
        failing
      );
    }
  }

  // 7-day baseline: calm, and thin on purpose. Ratio and quantile normals (the
  // failure rate and the latency/duration p95s) come out right; the per-minute
  // rate normals read low, because matching them would need millions of rows.
  const baselineMinutes = BASELINE_DAYS * 24 * 60;
  const baselinePerMin = Math.max(1, Math.round(STORY.baselineRunsPerMin * scale));
  for (let minute = 0; minute < baselineMinutes; minute++) {
    const minuteStart = now - (baselineMinutes - minute) * 60_000 - LIVE_WINDOW_MIN * 60_000;
    for (let i = 0; i < baselinePerMin; i++) {
      const created = minuteStart + Math.floor((i / baselinePerMin) * 60_000);
      const failing = rng() < STORY.baselineFailureRate;
      const task = failing ? { id: TASK_ID, queue: QUEUE } : tasks[(minute + i) % tasks.length];
      emit(
        created,
        task.id,
        task.queue,
        failing ? "COMPLETED_WITH_ERRORS" : "COMPLETED_SUCCESSFULLY",
        lognormal(STORY.calmWaitMedianMs, STORY.waitSigma, rng),
        lognormal(STORY.durationMedianMs, STORY.waitSigma, rng),
        failing
      );
    }
  }

  return specs;
}

async function insertTaskRuns(
  ch: ClickHouse,
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  nonce: string
) {
  const BATCH = 20_000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const [error] = await ch.taskRuns.insertCompactArrays(rows.slice(i, i + BATCH) as never, {
      params: {
        clickhouse_settings: { async_insert: 0, insert_deduplication_token: `${nonce}:${i}` },
      },
    });
    if (error) {
      console.error("task_runs_v2 insert failed:", error.message);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Spans, so the cited runs open onto a real trace
// ---------------------------------------------------------------------------

function spanRow(opts: {
  ids: ChIds;
  spec: RunSpec;
  spanId: string;
  parentSpanId: string;
  message: string;
  startMs: number;
  durationMs: number;
  isError?: boolean;
  isPartial?: boolean;
  attributes?: Record<string, unknown>;
}): TaskEventV2Input {
  const { ids, spec } = opts;
  return {
    environment_id: ids.environment_id,
    organization_id: ids.organization_id,
    project_id: ids.project_id,
    task_identifier: spec.taskIdentifier,
    run_id: spec.friendlyId,
    start_time: chStartTime(opts.startMs),
    duration: String(Math.max(0, Math.floor(opts.durationMs)) * 1_000_000),
    trace_id: spec.traceId,
    span_id: opts.spanId,
    parent_span_id: opts.parentSpanId,
    message: opts.message,
    kind: "SPAN",
    status: opts.isPartial ? "PARTIAL" : opts.isError ? "ERROR" : "OK",
    attributes: opts.attributes ?? {},
    metadata: JSON.stringify({ attemptNumber: spec.attemptNumber ?? 1 }),
    expires_at: chDateTime(new Date(Date.now() + 365 * 24 * 3600_000)),
    machine_id: spec.machinePreset,
  };
}

function buildSpans(specs: RunSpec[], ids: ChIds, now: number): TaskEventV2Input[] {
  const events: TaskEventV2Input[] = [];
  for (const spec of specs) {
    const start = (spec.startedAt ?? spec.createdAt).getTime();
    const end = spec.completedAt?.getTime() ?? now;
    const isError = Boolean(spec.error);
    const isRunning = !spec.completedAt && spec.status === "EXECUTING";
    const queued = spec.status === "PENDING";

    events.push(
      spanRow({
        ids,
        spec,
        spanId: spec.spanId,
        parentSpanId: "",
        message: spec.taskIdentifier,
        startMs: spec.createdAt.getTime(),
        durationMs: queued ? 0 : end - spec.createdAt.getTime(),
        isError,
        isPartial: queued || isRunning,
        attributes: { "run.id": spec.friendlyId, queue: spec.queue },
      })
    );
    if (queued) continue;

    if (spec.taskIdentifier === SLOW_TASK_ID) {
      // The whole point of the slow run: one long span with nothing inside it.
      events.push(
        spanRow({
          ids,
          spec,
          spanId: generateSpanId(),
          parentSpanId: spec.spanId,
          message: "aggregate",
          startMs: start + 20_000,
          durationMs: end - start - 21_000,
          isPartial: isRunning,
        })
      );
      continue;
    }

    const attempts = spec.attemptNumber ?? 1;
    const slice = Math.max(1, Math.floor((end - start) / attempts));
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const attemptStart = start + (attempt - 1) * slice;
      const lastAttempt = attempt === attempts;
      events.push(
        spanRow({
          ids,
          spec,
          spanId: generateSpanId(),
          parentSpanId: spec.spanId,
          message: `Attempt ${attempt}`,
          startMs: attemptStart,
          durationMs: slice,
          isError: isError,
        })
      );
      events.push(
        spanRow({
          ids,
          spec,
          spanId: generateSpanId(),
          parentSpanId: spec.spanId,
          message: "sendEmail",
          startMs: attemptStart + 40,
          durationMs: isError ? 412 : Math.max(40, slice - 120),
          isError,
          attributes: isError
            ? { "http.status_code": 429, "error.type": "ProviderError" }
            : { "http.status_code": 202 },
        })
      );
      if (!lastAttempt && !isError) break;
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Queue + env metrics: the calm baseline and the pinned window
// ---------------------------------------------------------------------------

type Odometers = Record<string, Record<string, number>>;

function counterRow(
  ids: ChIds,
  queueName: string,
  eventTime: string,
  op: "enqueue" | "started" | "ack" | "nack" | "dlq",
  odometers: Odometers,
  increment: number,
  orderKey: () => number,
  waitMs?: number
): QueueMetricsRawV1Input[] {
  const perQueue = (odometers[queueName] ??= { enqueue: 0, started: 0, ack: 0, nack: 0, dlq: 0 });
  const rows: QueueMetricsRawV1Input[] = [];
  // The rollup reads these as monotonic odometers, so the first row has to
  // establish a zero point before any delta can be attributed.
  if (perQueue[op] === 0) {
    rows.push({
      ...ids,
      queue_name: queueName,
      event_time: eventTime,
      op,
      cumulative: 0,
      order_key: orderKey(),
    });
  }
  perQueue[op] += increment;
  rows.push({
    ...ids,
    queue_name: queueName,
    event_time: eventTime,
    op,
    cumulative: perQueue[op],
    order_key: orderKey(),
    ...(waitMs !== undefined ? { wait_ms: waitMs } : {}),
  });
  return rows;
}

function buildQueueMetrics(ids: ChIds, now: number, rng: () => number): QueueMetricsRawV1Input[] {
  const rows: QueueMetricsRawV1Input[] = [];
  const odometers: Odometers = {};
  const queues = Object.keys(QUEUE_LIMITS);
  const envLimit = STORY.envConcurrencyLimit;

  let seq = 0;
  const orderKey = () => Math.floor(now / 1000) * 1_000_000 + seq++;

  const bucket = (
    bucketMs: number,
    bucketSec: number,
    opts: {
      envRunning: number;
      envQueued: number;
      startedPerQueue: number;
      arrivalsPerQueue: number;
      waitMedianMs: number;
      throttled: boolean;
      /**
       * Wait samples per bucket. The t-digest weights every sample equally, so a
       * 5-minute baseline bucket has to carry proportionally more of them than a
       * 10-second live bucket — otherwise the spike dominates the 7-day quantile
       * and the report reports its own anomaly as the normal.
       */
      waitSamples: number;
    }
  ) => {
    const eventTime = chDateTime(new Date(bucketMs));
    for (const queueName of queues) {
      const share = QUEUE_PENDING_SHARE[queueName];
      const queueLimit = QUEUE_LIMITS[queueName];
      const running = Math.min(queueLimit, Math.round(opts.envRunning * share));
      const queued = Math.round(opts.envQueued * share);
      rows.push({
        ...ids,
        queue_name: queueName,
        event_time: eventTime,
        op: "gauge",
        running,
        queued,
        queue_limit: queueLimit,
        env_running: opts.envRunning,
        env_queued: opts.envQueued,
        env_limit: envLimit,
        throttled: opts.throttled && queued > 0 ? 1 : 0,
      });

      const arrivals = Math.max(1, Math.round(opts.arrivalsPerQueue * share));
      const started = Math.max(1, Math.round(opts.startedPerQueue * share));
      rows.push(...counterRow(ids, queueName, eventTime, "enqueue", odometers, arrivals, orderKey));
      rows.push(...counterRow(ids, queueName, eventTime, "ack", odometers, started, orderKey));
      // A handful of samples per bucket is enough for the t-digest and keeps the
      // row count sane — one row per run would be a quarter of a million.
      const samples = opts.waitSamples;
      const perSample = Math.max(1, Math.round(started / samples));
      for (let s = 0; s < samples; s++) {
        rows.push(
          ...counterRow(
            ids,
            queueName,
            eventTime,
            "started",
            odometers,
            perSample,
            orderKey,
            lognormal(opts.waitMedianMs, STORY.waitSigma, rng)
          )
        );
      }
    }
  };

  // 7-day calm baseline at 5-minute spacing.
  const baselineBuckets = (BASELINE_DAYS * 24 * 3600) / BASELINE_BUCKET_SEC;
  const baselineStart =
    Math.floor((now - BASELINE_DAYS * 24 * 3600_000) / 1000 / BASELINE_BUCKET_SEC) *
    BASELINE_BUCKET_SEC *
    1000;
  for (let b = 0; b < baselineBuckets; b++) {
    const bucketMs = baselineStart + b * BASELINE_BUCKET_SEC * 1000;
    if (bucketMs >= now - LIVE_WINDOW_MIN * 60_000) break;
    bucket(bucketMs, BASELINE_BUCKET_SEC, {
      envRunning: 26 + Math.round(rng() * 8),
      envQueued: 34 + Math.round(rng() * 22),
      startedPerQueue: STORY.baselineRunsPerMin * (BASELINE_BUCKET_SEC / 60),
      arrivalsPerQueue: STORY.baselineRunsPerMin * (BASELINE_BUCKET_SEC / 60),
      waitMedianMs: STORY.calmWaitMedianMs,
      throttled: false,
      waitSamples: BASELINE_WAIT_SAMPLES,
    });
  }

  // The last hour at 10-second resolution: calm, then pinned at the ceiling with
  // pending climbing and start latency rising with it.
  const liveBuckets = (LIVE_WINDOW_MIN * 60) / BUCKET_SEC;
  const nowBucket = Math.floor(now / 1000 / BUCKET_SEC) * BUCKET_SEC * 1000;
  const spikeStart = now - STORY.pinnedMinutes * 60_000;
  for (let b = 0; b < liveBuckets; b++) {
    const bucketMs = nowBucket - (liveBuckets - 1 - b) * BUCKET_SEC * 1000;
    const pinned = bucketMs >= spikeStart;
    const progress = pinned ? (bucketMs - spikeStart) / (STORY.pinnedMinutes * 60_000) : 0;
    bucket(bucketMs, BUCKET_SEC, {
      envRunning: pinned ? envLimit : 28 + Math.round(rng() * 6),
      envQueued: pinned
        ? Math.round(60 + (STORY.pending - 60) * progress)
        : 40 + Math.round(rng() * 24),
      startedPerQueue: (STORY.donePerMin * BUCKET_SEC) / 60,
      arrivalsPerQueue: ((pinned ? STORY.triggeredPerMin : STORY.donePerMin) * BUCKET_SEC) / 60,
      waitMedianMs: pinned
        ? STORY.calmWaitMedianMs + (STORY.pinnedWaitMedianMs - STORY.calmWaitMedianMs) * progress
        : STORY.calmWaitMedianMs,
      throttled: pinned,
      waitSamples: LIVE_WAIT_SAMPLES,
    });
  }

  return rows;
}

async function insertQueueMetrics(ch: ClickHouse, rows: QueueMetricsRawV1Input[], nonce: string) {
  const BATCH = 25_000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const [error] = await ch.queueMetrics.insertRaw(rows.slice(i, i + BATCH), {
      params: {
        clickhouse_settings: { async_insert: 0, insert_deduplication_token: `${nonce}:${i}` },
      },
    });
    if (error) {
      console.error("queue_metrics_raw_v1 insert failed:", error.message);
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------------------
// Redis: the live env-queue depth the report prefers over the metric series
// ---------------------------------------------------------------------------

async function stageRedisDepth(
  organizationId: string,
  environmentId: string,
  depth: number,
  label: string
) {
  const host = process.env.RUN_ENGINE_RUN_QUEUE_REDIS_HOST ?? process.env.REDIS_HOST ?? "localhost";
  const port = Number(
    process.env.RUN_ENGINE_RUN_QUEUE_REDIS_PORT ?? process.env.REDIS_PORT ?? 6379
  );
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (!localHosts.has(host)) {
    console.warn(`[${label}] skipping Redis staging on a non-local host: ${host}`);
    return;
  }
  try {
    const { createRedisClient } = await import("@internal/redis");
    const redis = createRedisClient({ host, port });
    const envQueueKey = `engine:runqueue:{org:${organizationId}}:env:${environmentId}`;
    await redis.del(envQueueKey);
    const now = Date.now();
    const BATCH = 1_000;
    for (let i = 0; i < depth; i += BATCH) {
      const args: Array<string | number> = [];
      for (let j = i; j < Math.min(depth, i + BATCH); j++) {
        args.push(now + j, `seed_agentex_queued_${j}`);
      }
      await redis.zadd(envQueueKey, ...args);
    }
    await redis.quit();
    console.log(`[${label}] staged env-queue depth ${depth} in Redis`);
  } catch (error) {
    console.warn(
      `[${label}] Redis staging skipped:`,
      error instanceof Error ? error.message : error
    );
  }
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

const REPORT_SERIES_POINTS = 7;

function calmSeries(base: number, jitter: number): number[] {
  return Array.from(
    { length: REPORT_SERIES_POINTS },
    (_, i) => base + Math.round(Math.sin(i / 2) * jitter)
  );
}

function rampSeries(from: number, to: number): number[] {
  return Array.from({ length: REPORT_SERIES_POINTS }, (_, i) =>
    Math.round(from + ((to - from) * i) / (REPORT_SERIES_POINTS - 1))
  );
}

/**
 * The live health report, read back over HTTP from the running dev server.
 *
 * The presenter can't be called in-process: its module graph reaches
 * `@internal/clickhouse`, which publishes no CommonJS entry, and tsx compiles the
 * app's modules as CommonJS. Going through the public endpoint is closer to the
 * truth anyway — it's the same route the agent's `get_report` tool calls.
 */
async function fetchLiveHealthReport(appOrigin: string, apiKey: string): Promise<unknown | null> {
  const url = `${appOrigin}/api/v1/reports/health?format=json&period=1h`;
  try {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!response.ok) {
      console.warn(`Live health report unavailable (${response.status}); using the built one.`);
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn(
      `Live health report unavailable (${error instanceof Error ? error.message : error}); using the built one.`
    );
    return null;
  }
}

/**
 * The degraded report, built from the story's numbers through the real
 * interpreter. Used when the dev server isn't up to serve the live one; the
 * figures are the ones the seeded metrics produce, so the card says the same
 * thing either way.
 */
function buildDegradedReport(generatedAt: Date, envSlug: string): unknown {
  const input: HealthInput = {
    scope: envSlug,
    period: "last 1h",
    baselineLabel: "vs your 7d normal",
    generatedAt: generatedAt.toISOString(),
    windowMinutes: LIVE_WINDOW_MIN,
    flowSource: "queue_metrics_v1",
    pending: {
      now: STORY.pending,
      normal: 45,
      series: rampSeries(60, STORY.pending),
      estimated: false,
    },
    startLatency: {
      p95Ms: 43_000,
      normalP95Ms: 7_000,
      series: rampSeries(7_000, 43_000),
    },
    throughput: {
      donePerMin: STORY.donePerMin,
      triggeredPerMin: STORY.triggeredPerMin,
      normalTriggeredPerMin: 840,
    },
    failures: {
      rate: STORY.failureRate,
      normalRate: STORY.baselineFailureRate,
      series: calmSeries(6, 2).map((n) => n / 1000),
    },
    duration: { p95Ms: 4_200, normalP95Ms: 4_000 },
    liveness: { telemetryAgeMs: 18_000 },
    flowEvidence: {
      // Pinned for most of the window: what makes the cause env-limit saturation
      // rather than a slow dequeue.
      runningSeries: [28, 34, 50, 50, 50, 50, 50],
      envLimit: STORY.envConcurrencyLimit,
      throttledShare: STORY.pinnedMinutes / LIVE_WINDOW_MIN,
      worstQueue: { name: QUEUE, share: STORY.worstQueueShare },
      dlqDelta: 0,
    },
  };
  return interpret(input);
}

/** The figures the transcripts quote, taken out of the report they sit beside. */
function readReportFigures(report: unknown) {
  const vm = report as {
    findings?: Array<{
      type: string;
      attribution?: { dim: string; key: string; share: number };
    }>;
    metrics?: Array<{
      id: string;
      value: number;
      breakdown?: Record<string, number>;
      annotation?: { code: string; value?: number };
    }>;
    facts?: { throughput?: { donePerMin?: number; triggeredPerMin?: number } };
    footer?: Array<{ code: string; value?: number }>;
  };
  const metric = (id: string) => vm.metrics?.find((m) => m.id === id);
  const concurrency = metric("concurrency");
  const flow = vm.findings?.find((finding) => finding.type === "flow");
  const drain = vm.footer?.find((entry) => entry.code === "do_nothing_drains");

  return {
    envLimit: concurrency?.breakdown?.limit ?? concurrency?.value,
    pinnedMinutes:
      concurrency?.annotation?.code === "pinned_minutes"
        ? Math.round(concurrency.annotation.value ?? 0) || undefined
        : undefined,
    pending: metric("pending")?.value ? Math.round(metric("pending")!.value) : undefined,
    worstQueueShare: flow?.attribution?.dim === "queue" ? flow.attribution.share : undefined,
    donePerMin: vm.facts?.throughput?.donePerMin
      ? Math.round(vm.facts.throughput.donePerMin)
      : undefined,
    triggeredPerMin: vm.facts?.throughput?.triggeredPerMin
      ? Math.round(vm.facts.throughput.triggeredPerMin)
      : undefined,
    drainMinutes: drain?.value ? Math.round(drain.value) : undefined,
    failureRate: metric("failures")?.value,
  };
}

/**
 * The calm report for the "how is prod doing" conversation. It goes through the
 * real interpreter — only the input is hand-fed, describing the window before
 * the spike, which is a window the seeded data really had.
 */
function buildHealthyReport(generatedAt: Date, envSlug: string): unknown {
  const calm = (base: number, jitter: number) =>
    Array.from({ length: 7 }, (_, i) => base + Math.round(Math.sin(i / 2) * jitter));
  const input: HealthInput = {
    scope: envSlug,
    period: "last 1h",
    baselineLabel: "vs your 7d normal",
    generatedAt: generatedAt.toISOString(),
    windowMinutes: 60,
    flowSource: "queue_metrics_v1",
    pending: { now: 34, normal: 40, series: calm(36, 8), estimated: false },
    startLatency: { p95Ms: 6_800, normalP95Ms: 7_000, series: calm(6_800, 400) },
    throughput: { donePerMin: 842, triggeredPerMin: 830, normalTriggeredPerMin: 840 },
    failures: { rate: 0.004, normalRate: 0.005, series: calm(4, 2).map((n) => n / 1000) },
    duration: { p95Ms: 4_100, normalP95Ms: 4_000 },
    liveness: { telemetryAgeMs: 21_000 },
    flowEvidence: {
      runningSeries: calm(29, 4),
      envLimit: STORY.envConcurrencyLimit,
      throttledShare: 0,
      worstQueue: null,
      dlqDelta: 0,
    },
  };
  return interpret(input);
}

// ---------------------------------------------------------------------------
// Chats
// ---------------------------------------------------------------------------

function agentDb() {
  return createDashboardAgentDb(env.DASHBOARD_AGENT_DATABASE_URL ?? env.DATABASE_URL, { max: 2 });
}

/** Deletes only the chats this seeder minted — the id prefix is its marker. */
async function deleteSeededChats(client: ReturnType<typeof agentDb>, userId: string) {
  await client.sql`
    delete from trigger_dashboard_agent.chats
    where user_id = ${userId} and id like ${`${CHAT_ID_PREFIX}%`}`;
}

async function seedChats(
  client: ReturnType<typeof agentDb>,
  world: AgentExamplesWorld,
  organizationId: string,
  userId: string,
  projectId: string
) {
  const chats = buildAgentExampleChats(world);
  const now = Date.now();

  await deleteSeededChats(client, userId);

  for (const chat of chats) {
    const chatId = `${CHAT_ID_PREFIX}${chat.slug}`;
    const lastMessageAt = new Date(now - chat.minutesAgo * 60_000);
    await createChat(client.db, {
      id: chatId,
      organizationId,
      userId,
      title: chat.title,
      metadata: {
        context: {
          userId,
          organizationId,
          projectId,
          environmentId: world.environmentId,
          currentPage: `/orgs/${world.organizationSlug}/projects/${world.projectSlug}/env/${world.environmentSlug}/runs`,
        },
        seededBy: "seed-agent-examples",
      },
    });
    // `persistMessages` stamps `last_message_at` with now(), which would collapse
    // the whole history onto one timestamp. The transcripts are backdated instead,
    // so the list reads like a week of work.
    await client.sql`
      update trigger_dashboard_agent.chats
      set title = ${chat.title},
          messages = ${JSON.stringify(chat.messages)}::jsonb,
          last_message_at = ${lastMessageAt.toISOString()}::timestamptz,
          updated_at = ${lastMessageAt.toISOString()}::timestamptz
      where id = ${chatId}`;
  }

  return chats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Seeds the "${PROJECT_NAME}" project: the dashboard-agent example
conversations as real chats over real data.

Usage: pnpm --filter webapp run db:seed:agent-examples -- [flags]

Flags:
  --scale <n>    scale the seeded run volume (default 1). 0.1 seeds a tenth of
                 the rows for fast iteration; the story's headline numbers stay
                 the same, only the row counts shrink. Dev is seeded at
                 ${DEV_SCALE_FACTOR}x this.
  --reset-only   delete everything this seeder owns and exit
  --help         this text`);
}

/**
 * Everything that belongs to one environment. Called once per environment, so
 * dev is not an empty shell — it's the same world, generated fresh (its own run
 * ids, its own spans) rather than copied, which keeps friendly ids unique.
 */
async function seedEnvironment(opts: {
  ch: ClickHouse;
  organizationId: string;
  projectId: string;
  environment: { id: string; slug: string; apiKey: string; type: SeededEnvType };
  userId: string;
  now: number;
  scale: number;
  nonce: string;
  rng: () => number;
}) {
  const { ch, organizationId, projectId, environment, userId, now, scale, nonce, rng } = opts;
  const label = environment.slug;
  const ids: ChIds = {
    organization_id: organizationId,
    project_id: projectId,
    environment_id: environment.id,
  };

  const { worker } = await seedWorkerAndDeployment(
    projectId,
    environment.id,
    userId,
    new Date(now - 20 * 3600_000)
  );
  await seedQueues(projectId, environment.id, label);

  // The cast: Postgres rows + ClickHouse rows + spans, so every citation opens.
  const cast = buildCastRuns(now, rng);
  const castSpecs = [cast.failed, cast.waiting, cast.slow, cast.prior, ...cast.background];
  const runIdByFriendlyId = await insertPostgresRuns(castSpecs, {
    projectId,
    environmentId: environment.id,
    organizationId,
    workerId: worker.id,
    environmentType: environment.type,
  });
  console.log(`[${label}] created ${castSpecs.length} runs in Postgres`);

  const bulkSpecs = buildBulkRuns(now, scale, rng);
  const runRows = [
    ...castSpecs.map((spec) =>
      taskRunRow(spec, runIdByFriendlyId.get(spec.friendlyId)!, ids, String(now), environment.type)
    ),
    ...bulkSpecs.map((spec) =>
      taskRunRow(spec, syntheticRunId(), ids, String(now), environment.type)
    ),
  ];
  await insertTaskRuns(ch, runRows, `${nonce}:${label}:runs`);
  console.log(
    `[${label}] inserted ${runRows.length} task_runs_v2 rows (${bulkSpecs.length} for volume)`
  );

  const spans = buildSpans(castSpecs, ids, now);
  const [spanError] = await ch.taskEventsV2.insert(spans, {
    params: { clickhouse_settings: { async_insert: 0 } },
  });
  if (spanError) {
    console.error(`[${label}] task_events_v2 insert failed:`, spanError.message);
    process.exit(1);
  }
  console.log(`[${label}] inserted ${spans.length} spans`);

  const metricRows = buildQueueMetrics(ids, now, rng);
  await insertQueueMetrics(ch, metricRows, `${nonce}:${label}:metrics`);
  console.log(`[${label}] inserted ${metricRows.length} queue_metrics_raw_v1 rows`);

  // The pending depth the report prefers over the metric series. The queue
  // metrics are not scaled, so both environments tell the same depth story.
  await stageRedisDepth(organizationId, environment.id, STORY.pending, label);

  return { environment, cast, castSpecs, bulkSpecs };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help === "true") {
    printHelp();
    process.exit(0);
  }
  const scale = Number(flags.scale ?? 1);
  if (!Number.isFinite(scale) || scale <= 0) {
    console.error(`--scale must be a positive number, got: ${flags.scale}`);
    process.exit(1);
  }

  const user = await prisma.user.findFirst({ where: { email: "local@trigger.dev" } });
  if (!user) {
    console.error("User local@trigger.dev not found. Run `pnpm run db:seed` first.");
    process.exit(1);
  }

  const { org, project, environments } = await seedPostgresShell(user.id);
  const ch = clickhouse();
  const agentDbClient = agentDb();

  for (const environment of environments) {
    await resetPostgresData(environment.id, project.id, environment.slug);
    await resetClickhouse(ch, environment.id, environment.slug);
  }
  if (flags["reset-only"] === "true") {
    await deleteSeededChats(agentDbClient, user.id);
    for (const environment of environments) {
      await stageRedisDepth(org.id, environment.id, 0, environment.slug);
    }
    await agentDbClient.close();
    await ch.close();
    console.log("Reset complete.");
    process.exit(0);
  }

  const now = Date.now();
  const rng = mulberry32(20260727);
  const nonce = `agentex-${now}`;

  // Prod first: it's the environment the transcripts cite, so its cast is the one
  // the world is built from.
  const seeded = [];
  for (const environment of environments) {
    seeded.push(
      await seedEnvironment({
        ch,
        organizationId: org.id,
        projectId: project.id,
        environment,
        userId: user.id,
        now,
        // Dev exists so the project isn't empty on the page people land on; it
        // doesn't need prod's row count to look alive.
        scale: environment.type === "PRODUCTION" ? scale : scale * DEV_SCALE_FACTOR,
        nonce,
        rng,
      })
    );
  }
  const prod = seeded[0];
  const { environment, cast, castSpecs, bulkSpecs } = prod;

  // The rollups are AggregatingMergeTrees; the real pipeline waits for background
  // merges, and a seeder that is about to read them cannot.
  const raw = rawClient(ch);
  for (const table of [
    "queue_metrics_v1",
    "queue_metrics_5m_v1",
    "env_metrics_v1",
    "errors_v1",
    "error_occurrences_v1",
  ]) {
    await raw.command({ query: `OPTIMIZE TABLE trigger_dev.${table} FINAL` });
  }

  // The degraded card is the live report over the rows above, when the dev server
  // is up to serve it.
  const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:3030";
  const live = await fetchLiveHealthReport(appOrigin, environment.apiKey);
  const degraded = live ?? buildDegradedReport(new Date(now), environment.slug);
  const summary = (degraded as { summary?: { severity?: string } }).summary;
  const flow = (degraded as { findings?: Array<{ type: string; reason: string }> }).findings?.find(
    (finding) => finding.type === "flow"
  );
  console.log(
    `Health report (${live ? "live" : "built"}): severity ${summary?.severity}, flow ${flow?.reason}`
  );
  const healthy = buildHealthyReport(new Date(now - 3 * 3600_000), environment.slug);

  // Read the story's figures back out of the report that will be shown, so the
  // prose in the transcripts quotes the card next to it rather than the constants
  // the data was generated from. Anything the report doesn't carry falls back.
  const reported = readReportFigures(degraded);
  const liveWindowStart = now - LIVE_WINDOW_MIN * 60_000;
  const failureCount = [...castSpecs, ...bulkSpecs].filter(
    (spec) => spec.status === "COMPLETED_WITH_ERRORS" && spec.createdAt.getTime() >= liveWindowStart
  ).length;

  const world: AgentExamplesWorld = {
    organizationSlug: org.slug,
    projectSlug: project.slug,
    projectRef: project.externalRef,
    environmentId: environment.id,
    environmentSlug: environment.slug,
    appOrigin,
    failedRunId: cast.failed.friendlyId,
    failedSpanId: cast.failed.spanId,
    waitingRunId: cast.waiting.friendlyId,
    slowRunId: cast.slow.friendlyId,
    priorRunId: cast.prior.friendlyId,
    taskId: TASK_ID,
    slowTaskId: SLOW_TASK_ID,
    queue: QUEUE,
    backlogQueue: BACKLOG_QUEUE,
    errorFingerprint: ERROR_FINGERPRINT,
    deploymentVersion: DEPLOYMENT_VERSION,
    sourceSha: GIT_SHA,
    sourcePath: SOURCE_PATH,
    envConcurrencyLimit: reported.envLimit ?? STORY.envConcurrencyLimit,
    pinnedMinutes: reported.pinnedMinutes ?? STORY.pinnedMinutes,
    pending: reported.pending ?? STORY.pending,
    worstQueueShare: reported.worstQueueShare ?? STORY.worstQueueShare,
    failureCount,
    failureRatePct: ((reported.failureRate ?? STORY.failureRate) * 100).toFixed(1),
    donePerMin: reported.donePerMin ?? STORY.donePerMin,
    triggeredPerMin: reported.triggeredPerMin ?? STORY.triggeredPerMin,
    drainMinutes: reported.drainMinutes ?? STORY.drainMinutes,
    firstFailureClock: clock(cast.prior.createdAt),
    lastFailureClock: clock(cast.failed.createdAt),
    degradedReport: degraded,
    healthyReport: healthy,
  };

  const chats = await seedChats(agentDbClient, world, org.id, user.id, project.id);

  await agentDbClient.close();
  await ch.close();

  const dashboardUrl = `${world.appOrigin}/orgs/${org.slug}/projects/${project.slug}/env/${environment.slug}/runs`;
  console.log(`
Done.

  Organization  ${org.title} (${org.slug})
  Project       ${project.name} (${project.slug}) — ${project.externalRef}
  Environments  ${seeded
    .map(({ environment: env }) => `${env.slug} (${env.id})`)
    .join("\n                ")}
  Deployment    ${DEPLOYMENT_VERSION} @ ${GIT_SHA.slice(0, 7)}
  Error group   ${ERROR_FINGERPRINT}
  Cited runs    failed ${cast.failed.friendlyId}
                queued ${cast.waiting.friendlyId}
                slow   ${cast.slow.friendlyId}
                prior  ${cast.prior.friendlyId}

  Dashboard     ${dashboardUrl}
                (dev is seeded too — the cited runs above are prod's)

  Seeded chats (${chats.length}):`);
  for (const chat of chats) {
    console.log(`    - ${chat.title}`);
  }
  console.log(`
  Not ported from demo mode (${SKIPPED_DEMO_CHATS.length}):`);
  for (const skipped of SKIPPED_DEMO_CHATS) {
    console.log(`    - ${skipped.id}: ${skipped.reason}`);
  }
  console.log(
    `
  The panel is on for this org via the hasDashboardAgentAccess flag. Talking to
  the agent still needs DASHBOARD_AGENT_ENABLED and its API key; reading the
  seeded history does not.
`
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
