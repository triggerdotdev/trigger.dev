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
 *   pnpm --filter webapp run db:seed:agent-examples -- --heartbeat    # keep it fresh
 *   pnpm --filter webapp run db:seed:agent-examples -- --recover      # flip to healthy
 *   pnpm --filter webapp run db:seed:agent-examples -- --degrade       # flip back
 *
 * `--heartbeat` is the answer to a stand that ages: it appends a minute of fresh
 * telemetry to both environments every minute, so the report's liveness finding
 * keeps reading "fresh" and `facts.trustworthy` stays true. It seeds nothing and
 * wipes nothing — run the full seed first, then leave a heartbeat running beside
 * it. See the heartbeat section below for what a tick writes and what it can't
 * hold still.
 *
 * `--recover` / `--degrade` are the switch the recovery-watch demo needs: the
 * stand's default story is permanently degraded, and a watch only fires when the
 * report actually flips to "ok". Each flag rewrites the report's live window for
 * both environments and leaves the mode behind in a state file the heartbeat
 * re-reads every tick, so the flip sticks instead of being overwritten 30 seconds
 * later. See the recovery section below.
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
 * One invariant the whole file is arranged around: **the runs list gets its ids
 * from ClickHouse and hydrates them from Postgres, dropping any id it can't find
 * there.** So anything that can reach the first pages of that list needs a
 * Postgres row, not just a ClickHouse one — the cast, the recent runs
 * (`RECENT_PG_RUNS`, more than a page of them) and every heartbeat trickle run
 * all have both. Only the deep volume rows are ClickHouse-only, and they are
 * backdated behind the Postgres-backed ones so they can't surface on page 1.
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
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

/**
 * The recovered story, for `--recover` and for the heartbeat's calm mode. Everything
 * here reads healthy against the seeded 7-day baseline: a quarter of the ceiling in use,
 * a backlog of a few runs against a normal of ~45, and the baseline's own wait median so
 * the start-latency ratio lands on 1x.
 */
const CALM = {
  /** Share of the env ceiling a calm bucket runs at. */
  runningShare: 0.25,
  /** Env-level pending depth in a calm bucket. */
  queuedMax: 2,
  /** Live env-queue depth staged in Redis while calm — the number `pending` reports. */
  pendingDepth: 12,
  /** Minutes of calm buckets `--recover` writes, so the live window isn't empty. */
  windowMinutes: 10,
} as const;

/** Minutes of pinned buckets `--degrade` writes back. */
const DEGRADE_WINDOW_MINUTES = 35;

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

/**
 * How many Postgres-backed runs sit above the ClickHouse-only volume rows.
 *
 * The runs list pages 25 at a time (`DEFAULT_PAGE_SIZE` in
 * `NextRunListPresenter`) and drops ids it can't hydrate from Postgres, so this
 * has to comfortably exceed a page — two pages' worth, so the heartbeat and a bit
 * of drift can't eat the margin.
 */
const RECENT_PG_RUNS = 60;
/** The window those runs are spread across. */
const RECENT_RUNS_WINDOW_MS = 170_000;
/**
 * Where the ClickHouse-only volume stops, comfortably older than the oldest
 * Postgres-backed recent run — this gap is what keeps volume rows off page 1.
 */
const VOLUME_END_MS = RECENT_RUNS_WINDOW_MS + 10_000;
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

type RawCommand = {
  command: (a: { query: string }) => Promise<unknown>;
  query: (a: { query: string; format: string }) => Promise<{ json: () => Promise<unknown> }>;
};

function rawClient(ch: ClickHouse): RawCommand {
  return (ch.writer as unknown as { client: RawCommand }).client;
}

/**
 * Block until no mutation is outstanding. `mutations_sync = 2` already waits for the
 * ALTER it's attached to, so this is the belt to that braces: a rollup's mutation can
 * still be finishing when the next one is issued, and an insert that lands mid-mutation
 * is the one way a "deleted" bucket comes back.
 */
async function waitForMutations(raw: RawCommand, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await raw.query({
      query: `SELECT count() AS pending FROM system.mutations WHERE is_done = 0 AND database = 'trigger_dev'`,
      format: "JSONEachRow",
    });
    const rows = (await result.json()) as Array<{ pending: string | number }>;
    if (Number(rows[0]?.pending ?? 0) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  console.warn("Mutations still running after the wait — the report may lag a little.");
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
  //
  // These have to outnumber a page of the runs list. The list gets its ids from
  // ClickHouse and hydrates them from Postgres, dropping any id with no Postgres
  // row — so a page whose newest ids are all volume rows renders empty. Every run
  // built here has a Postgres row, they are all newer than the newest volume row
  // (see `buildBulkRuns`), and there are more of them than `DEFAULT_PAGE_SIZE`.
  const background: RunSpec[] = [];
  const backgroundTasks = [
    { id: TASK_ID, queue: QUEUE },
    { id: "send-welcome-email", queue: QUEUE },
    { id: "sync-inventory", queue: HEALTHY_QUEUE },
  ];
  for (let i = 0; i < RECENT_PG_RUNS; i++) {
    const task = backgroundTasks[i % backgroundTasks.length];
    const created = new Date(
      now -
        RECENT_RUNS_WINDOW_MS +
        Math.floor((i / RECENT_PG_RUNS) * (RECENT_RUNS_WINDOW_MS - 8_000))
    );
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

/**
 * A Prisma-shaped cuid. Supplied rather than defaulted so the whole batch can go
 * in with one `createMany` and still be mapped back to its ClickHouse rows.
 */
function runRowId(): string {
  let body = "";
  while (body.length < 24) body += Math.random().toString(36).slice(2);
  return `c${body.slice(0, 24)}`;
}

async function insertPostgresRuns(
  specs: RunSpec[],
  ids: {
    projectId: string;
    environmentId: string;
    organizationId: string;
    /** Null when the stand has no seeded deployment — the run is simply unlocked. */
    workerId: string | null;
    environmentType: SeededEnvType;
    /** Run numbers are per-environment and user-visible, so they keep climbing. */
    startNumber?: number;
  }
): Promise<Map<string, string>> {
  const runIdByFriendlyId = new Map<string, string>();
  let number = ids.startNumber ?? 1;
  const data = specs.map((spec) => {
    const id = runRowId();
    runIdByFriendlyId.set(spec.friendlyId, id);
    return {
      id,
      number: number++,
      friendlyId: spec.friendlyId,
      engine: "V2" as const,
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
    };
  });
  // One statement, not one per run: the heartbeat calls this every tick and its
  // budget is a couple of hundred milliseconds for everything.
  await prisma.taskRun.createMany({ data });
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

/** One volume run. Shared by the backfill and the heartbeat's per-tick trickle. */
function makeRunSpec(opts: {
  created: number;
  task: string;
  queue: string;
  status: string;
  waitMs: number;
  durationMs: number;
  failing: boolean;
  tags?: string[];
}): RunSpec {
  const startedAt = new Date(opts.created + opts.waitMs);
  const finished = opts.status !== "PENDING";
  return {
    friendlyId: generateFriendlyId("run"),
    taskIdentifier: opts.task,
    queue: opts.queue,
    status: opts.status,
    createdAt: new Date(opts.created),
    queuedAt: new Date(opts.created),
    ...(finished
      ? {
          startedAt,
          executedAt: new Date(startedAt.getTime() + 200),
          completedAt: new Date(startedAt.getTime() + 200 + opts.durationMs),
        }
      : {}),
    attemptNumber: finished ? (opts.failing ? 3 : 1) : undefined,
    ...(opts.failing ? { error: PROVIDER_ERROR } : {}),
    payload: "{}",
    spanId: generateSpanId(),
    traceId: generateTraceId(),
    machinePreset: "small-1x",
    usageDurationMs: finished ? opts.durationMs : 0,
    tags: opts.tags ?? [],
  };
}

/** The tasks the volume rows spread across. */
const VOLUME_TASKS: Array<{ id: string; queue: string }> = [
  { id: TASK_ID, queue: QUEUE },
  { id: "send-welcome-email", queue: QUEUE },
  { id: "sync-inventory", queue: HEALTHY_QUEUE },
  { id: SLOW_TASK_ID, queue: BACKLOG_QUEUE },
];

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
    specs.push(makeRunSpec({ created, task, queue, status, waitMs, durationMs, failing }));
  };

  const tasks = VOLUME_TASKS;

  // Live window. Arrivals at the spike rate; completions at the drain rate, so
  // the remainder is the backlog the report attributes to the env limit.
  const liveEnd = now - VOLUME_END_MS;
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

type BucketShape = {
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
};

/**
 * A bucket emitter with the per-queue odometers held in its closure, so the
 * backfill and the heartbeat can both append buckets without the counters
 * disagreeing. A fresh emitter restarts its odometers at zero; the rollup reads
 * that as a counter reset (`deltaSumTimestamp` is built for it) and keeps
 * attributing deltas correctly, which is what lets a heartbeat process pick up
 * where a previous one left off.
 */
function createBucketEmitter(ids: ChIds, epochMs: number, rng: () => number) {
  const odometers: Odometers = {};
  const queues = Object.keys(QUEUE_LIMITS);
  const envLimit = STORY.envConcurrencyLimit;

  // Strictly increasing for the life of the emitter, seeded from the wall clock so
  // a later process's keys always sort after an earlier one's. A counter rather
  // than `base + seq` so a long-lived heartbeat can't run the sequence into the
  // next second's base.
  let key = Math.floor(epochMs / 1000) * 1_000_000;
  const orderKey = () => ++key;

  return (bucketMs: number, opts: BucketShape): QueueMetricsRawV1Input[] => {
    const rows: QueueMetricsRawV1Input[] = [];
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
    return rows;
  };
}

/**
 * A pinned bucket: the ceiling held, the backlog and the start latency climbing with
 * `progress` (0 at the start of the spike, 1 now). Shared by the seed's live window and
 * `--degrade`, so both flips tell the same story.
 */
function pinnedBucketShape(progress: number): BucketShape {
  return {
    envRunning: STORY.envConcurrencyLimit,
    envQueued: Math.round(60 + (STORY.pending - 60) * progress),
    startedPerQueue: (STORY.donePerMin * BUCKET_SEC) / 60,
    arrivalsPerQueue: (STORY.triggeredPerMin * BUCKET_SEC) / 60,
    waitMedianMs:
      STORY.calmWaitMedianMs + (STORY.pinnedWaitMedianMs - STORY.calmWaitMedianMs) * progress,
    throttled: true,
    waitSamples: LIVE_WAIT_SAMPLES,
  };
}

/**
 * A calm bucket: a quarter of the ceiling in use, a couple of runs waiting, arrivals
 * matching starts, no throttling. The backlog *decreases* across `progress` on purpose —
 * `isPendingIncreasing` reads direction only, and a rising series flags the throughput
 * metric even when the depth is two runs.
 */
function calmBucketShape(progress: number, ratePerMin: number, rng: () => number): BucketShape {
  return {
    envRunning:
      Math.round(STORY.envConcurrencyLimit * CALM.runningShare) + Math.round(rng() * 3) - 1,
    envQueued: Math.max(0, Math.round(CALM.queuedMax * (1 - progress))),
    startedPerQueue: (ratePerMin * BUCKET_SEC) / 60,
    arrivalsPerQueue: (ratePerMin * BUCKET_SEC) / 60,
    waitMedianMs: STORY.calmWaitMedianMs,
    throttled: false,
    waitSamples: LIVE_WAIT_SAMPLES,
  };
}

function buildQueueMetrics(ids: ChIds, now: number, rng: () => number): QueueMetricsRawV1Input[] {
  const rows: QueueMetricsRawV1Input[] = [];
  const emit = createBucketEmitter(ids, now, rng);
  const bucket = (bucketMs: number, _bucketSec: number, opts: BucketShape) => {
    rows.push(...emit(bucketMs, opts));
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
    bucket(
      bucketMs,
      BUCKET_SEC,
      pinned
        ? pinnedBucketShape(progress)
        : {
            envRunning: 28 + Math.round(rng() * 6),
            envQueued: 40 + Math.round(rng() * 24),
            startedPerQueue: (STORY.donePerMin * BUCKET_SEC) / 60,
            arrivalsPerQueue: (STORY.donePerMin * BUCKET_SEC) / 60,
            waitMedianMs: STORY.calmWaitMedianMs,
            throttled: false,
            waitSamples: LIVE_WAIT_SAMPLES,
          }
    );
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

function redisConnection(): { host: string; port: number } | null {
  const host = process.env.RUN_ENGINE_RUN_QUEUE_REDIS_HOST ?? process.env.REDIS_HOST ?? "localhost";
  const port = Number(
    process.env.RUN_ENGINE_RUN_QUEUE_REDIS_PORT ?? process.env.REDIS_PORT ?? 6379
  );
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (!localHosts.has(host)) {
    console.warn(`Skipping Redis staging on a non-local host: ${host}`);
    return null;
  }
  return { host, port };
}

function envQueueKey(organizationId: string, environmentId: string): string {
  return `engine:runqueue:{org:${organizationId}}:env:${environmentId}`;
}

type RedisLike = {
  del: (key: string) => Promise<unknown>;
  zadd: (key: string, ...args: Array<string | number>) => Promise<unknown>;
  zcard: (key: string) => Promise<number>;
  quit: () => Promise<unknown>;
};

async function writeRedisDepth(
  redis: RedisLike,
  organizationId: string,
  environmentId: string,
  depth: number
) {
  const key = envQueueKey(organizationId, environmentId);
  await redis.del(key);
  const now = Date.now();
  const BATCH = 1_000;
  for (let i = 0; i < depth; i += BATCH) {
    const args: Array<string | number> = [];
    for (let j = i; j < Math.min(depth, i + BATCH); j++) {
      args.push(now + j, `seed_agentex_queued_${j}`);
    }
    await redis.zadd(key, ...args);
  }
}

async function stageRedisDepth(
  organizationId: string,
  environmentId: string,
  depth: number,
  label: string
) {
  const connection = redisConnection();
  if (!connection) return;
  try {
    const { createRedisClient } = await import("@internal/redis");
    const redis = createRedisClient(connection) as unknown as RedisLike;
    await writeRedisDepth(redis, organizationId, environmentId, depth);
    await redis.quit();
    console.log(`[${label}] staged env-queue depth ${depth} in Redis`);
  } catch (error) {
    console.warn(
      `[${label}] Redis staging skipped:`,
      error instanceof Error ? error.message : error
    );
  }
}

/**
 * Per-tick depth top-up. The key has no TTL, so the usual case is a single ZCARD
 * that finds it already correct — restaging ~5k members every minute would be
 * most of the tick's budget for no gain.
 */
async function refreshRedisDepth(
  organizationId: string,
  envs: Array<{ environment: { id: string; slug: string } }>,
  depth: number
) {
  const connection = redisConnection();
  if (!connection) return;
  try {
    const { createRedisClient } = await import("@internal/redis");
    const redis = createRedisClient(connection) as unknown as RedisLike;
    for (const { environment } of envs) {
      const current = await redis.zcard(envQueueKey(organizationId, environment.id));
      if (Math.abs(current - depth) > depth * 0.01) {
        await writeRedisDepth(redis, organizationId, environment.id, depth);
      }
    }
    await redis.quit();
  } catch (error) {
    console.warn("Redis depth refresh skipped:", error instanceof Error ? error.message : error);
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
// Recovery: the switch between the degraded story and a healthy one
// ---------------------------------------------------------------------------

/**
 * Which story the stand is telling. The default is `degraded` — that's the story every
 * transcript cites, and an absent state file must not quietly change it.
 */
type HeartbeatMode = "degraded" | "calm";

/**
 * The mode lives in a file rather than in the heartbeat process, because the two things
 * that need to agree about it run in different processes: a long-lived heartbeat and a
 * one-shot `--recover`. The heartbeat re-reads it every tick, so flipping the file flips
 * the next tick's writes with no restart.
 */
const HEARTBEAT_MODE_FILE = fileURLToPath(
  new URL("./.agent-examples-heartbeat-mode", import.meta.url)
);

function readHeartbeatMode(): HeartbeatMode {
  try {
    return readFileSync(HEARTBEAT_MODE_FILE, "utf8").trim().toLowerCase() === "calm"
      ? "calm"
      : "degraded";
  } catch {
    return "degraded";
  }
}

function writeHeartbeatMode(mode: HeartbeatMode) {
  writeFileSync(HEARTBEAT_MODE_FILE, `${mode}\n`);
  console.log(`Heartbeat mode file set to "${mode}" (${HEARTBEAT_MODE_FILE})`);
}

/**
 * Every queue-metrics table the seeder's rows reach. The rollups are fed by materialized
 * views on insert, so deleting the raw landing table does nothing to what the report
 * reads — each table has to be deleted from by name. `queue_metrics_ck_v1` only takes
 * rows with a concurrency key, which this seeder never writes; it's listed so a future
 * one can't leak past the flip.
 */
const QUEUE_METRIC_TABLES: Array<{ table: string; timeColumn: string; envQueuedColumn?: string }> =
  [
    { table: "queue_metrics_raw_v1", timeColumn: "event_time", envQueuedColumn: "env_queued" },
    { table: "queue_metrics_v1", timeColumn: "bucket_start", envQueuedColumn: "max_env_queued" },
    { table: "queue_metrics_5m_v1", timeColumn: "bucket_start", envQueuedColumn: "max_env_queued" },
    { table: "env_metrics_v1", timeColumn: "bucket_start", envQueuedColumn: "max_env_queued" },
    { table: "queue_metrics_ck_v1", timeColumn: "bucket_start" },
  ];

/**
 * How far back a flip rewrites. The report reads a 1h window; 2h clears it with room for
 * the last degraded heartbeat tick and any clock skew, and stops well short of the 7-day
 * baseline — which is what makes the recovered report *trustworthy* rather than empty.
 */
const FLIP_LOOKBACK_HOURS = 2;

/**
 * Above this env-level depth a bucket is part of the pinned story, not the calm baseline:
 * calm baseline buckets sit at 34-56 and calm-mode buckets at 0-2, while the pinned ramp
 * starts at 60 and ends at ~4.8k. Used to purge the pinned story from *outside* the flip
 * window, which a long-running degraded heartbeat writes into the 7-day baseline.
 */
const DEGRADED_QUEUED_FLOOR = 200;

/** Deletes this environment's queue metrics inside the flip window, everywhere they land. */
async function deleteFlipWindow(ch: ClickHouse, environmentId: string, label: string) {
  const raw = rawClient(ch);
  for (const { table, timeColumn } of QUEUE_METRIC_TABLES) {
    await raw.command({
      query: `ALTER TABLE trigger_dev.${table} DELETE WHERE environment_id = '${environmentId}'
              AND ${timeColumn} > now() - INTERVAL ${FLIP_LOOKBACK_HOURS} HOUR
              SETTINGS mutations_sync = 2`,
    });
  }
  await waitForMutations(raw);
  console.log(`[${label}] deleted the last ${FLIP_LOOKBACK_HOURS}h of queue metrics`);
}

/**
 * Deletes the pinned buckets a degraded heartbeat left *behind* the flip window. Hours of
 * 10-second pinned buckets outnumber the seeded 5-minute baseline by orders of magnitude,
 * so the 7-day normals drift up to the anomaly's own numbers (`pending` normal ~4.8k) and
 * the degraded window stops reading as degraded. Scoped by depth, so calm baseline buckets
 * survive — they're the baseline the report needs.
 */
async function purgeDegradedBaseline(ch: ClickHouse, environmentId: string, label: string) {
  const raw = rawClient(ch);
  for (const { table, timeColumn, envQueuedColumn } of QUEUE_METRIC_TABLES) {
    if (!envQueuedColumn) continue;
    await raw.command({
      query: `ALTER TABLE trigger_dev.${table} DELETE WHERE environment_id = '${environmentId}'
              AND ${timeColumn} <= now() - INTERVAL ${FLIP_LOOKBACK_HOURS} HOUR
              AND ${envQueuedColumn} >= ${DEGRADED_QUEUED_FLOOR}
              SETTINGS mutations_sync = 2`,
    });
  }
  await waitForMutations(raw);
  console.log(`[${label}] purged pinned buckets from the 7d baseline`);
}

/**
 * Writes a fresh live window ending now, in one mode or the other, through the same
 * emitter the seed and the heartbeat use — only the gauge numbers differ.
 */
async function writeFlipWindow(opts: {
  ch: ClickHouse;
  ids: ChIds;
  mode: HeartbeatMode;
  minutes: number;
  ratePerMin: number;
  now: number;
  rng: () => number;
  nonce: string;
  label: string;
}): Promise<number> {
  const { ch, ids, mode, minutes, ratePerMin, now, rng, nonce, label } = opts;
  const emit = createBucketEmitter(ids, now, rng);
  const buckets = Math.round((minutes * 60) / BUCKET_SEC);
  const nowBucket = Math.floor(now / 1000 / BUCKET_SEC) * BUCKET_SEC * 1000;
  const rows: QueueMetricsRawV1Input[] = [];
  for (let b = 0; b < buckets; b++) {
    const bucketMs = nowBucket - (buckets - 1 - b) * BUCKET_SEC * 1000;
    const progress = buckets === 1 ? 1 : b / (buckets - 1);
    rows.push(
      ...emit(
        bucketMs,
        mode === "calm" ? calmBucketShape(progress, ratePerMin, rng) : pinnedBucketShape(progress)
      )
    );
  }
  await insertQueueMetrics(ch, rows, `${nonce}:${label}:flip`);
  console.log(`[${label}] wrote ${minutes}m of ${mode} buckets (${rows.length} rows)`);
  return rows.length;
}

/** The rollups are AggregatingMergeTrees; a flip that is about to be read can't wait for merges. */
async function optimizeRollups(ch: ClickHouse) {
  const raw = rawClient(ch);
  for (const { table } of QUEUE_METRIC_TABLES) {
    if (table === "queue_metrics_raw_v1") continue;
    await raw.command({ query: `OPTIMIZE TABLE trigger_dev.${table} FINAL` });
  }
}

type StandEnv = { id: string; slug: string; apiKey: string; type: SeededEnvType };

/** Looks the seeded stand up without touching it — both flips run on top of an existing one. */
async function lookupStand(): Promise<{
  organizationId: string;
  projectId: string;
  environments: StandEnv[];
}> {
  const project = await prisma.project.findFirst({ where: { externalRef: PROJECT_REF } });
  if (!project) {
    console.error(
      `No "${PROJECT_NAME}" project found. Run the full seed first:\n` +
        `  pnpm --filter webapp run db:seed:agent-examples`
    );
    process.exit(1);
  }
  const environments: StandEnv[] = [];
  for (const type of ENV_TYPES) {
    const environment = await prisma.runtimeEnvironment.findFirst({
      where: { projectId: project.id, type },
    });
    if (!environment) {
      console.error(`No ${type} environment on project ${project.slug}.`);
      process.exit(1);
    }
    environments.push({
      id: environment.id,
      slug: environment.slug,
      apiKey: environment.apiKey,
      type: type as SeededEnvType,
    });
  }
  return { organizationId: project.organizationId, projectId: project.id, environments };
}

/** Reads the live report for one environment back and prints the two figures a flip is judged on. */
async function printLiveSeverity(environment: StandEnv, label: string) {
  const appOrigin = process.env.APP_ORIGIN ?? "http://localhost:3030";
  const report = await fetchLiveHealthReport(appOrigin, environment.apiKey);
  if (!report) {
    console.log(`[${label}] no live report — is the dev server up on ${appOrigin}?`);
    return;
  }
  const vm = report as {
    summary?: { severity?: string };
    facts?: { trustworthy?: boolean };
    findings?: Array<{ type: string; severity: string; reason: string }>;
  };
  const findings = (vm.findings ?? [])
    .map((finding) => `${finding.type} ${finding.severity}/${finding.reason}`)
    .join(", ");
  console.log(
    `[${label}] health report: severity ${vm.summary?.severity}, trustworthy ${vm.facts?.trustworthy} — ${findings}`
  );
}

/**
 * One-shot flip. `calm` clears the degraded window, writes a short calm one in its place,
 * drops the live Redis depth and leaves the heartbeat in calm mode; `degraded` is the
 * inverse, and additionally purges the pinned buckets a long heartbeat has pushed into the
 * 7-day baseline — without that the degraded window is measured against itself and reads
 * as normal.
 */
async function runFlip(mode: HeartbeatMode, scale: number) {
  const { organizationId, projectId, environments } = await lookupStand();
  const ch = clickhouse();
  const rng = mulberry32(Date.now() & 0xffff);
  const nonce = `agentex-flip-${Date.now()}`;
  const now = Date.now();

  // Written first: a heartbeat tick landing mid-flip should already be writing the new
  // story rather than the one we're deleting.
  writeHeartbeatMode(mode);

  for (const environment of environments) {
    const ids: ChIds = {
      organization_id: organizationId,
      project_id: projectId,
      environment_id: environment.id,
    };
    if (mode === "degraded") {
      // Merge first: an AggregatingMergeTree keeps several partial rows per bucket until it
      // merges, and a DELETE on `max_env_queued` only sees the value each *part* holds — so
      // an unmerged pinned bucket survives the purge in a part whose max is calm.
      await optimizeRollups(ch);
      await purgeDegradedBaseline(ch, environment.id, environment.slug);
    }
    await deleteFlipWindow(ch, environment.id, environment.slug);
    await writeFlipWindow({
      ch,
      ids,
      mode,
      minutes: mode === "calm" ? CALM.windowMinutes : DEGRADE_WINDOW_MINUTES,
      ratePerMin:
        STORY.baselineRunsPerMin *
        scale *
        (environment.type === "PRODUCTION" ? 1 : DEV_SCALE_FACTOR),
      now,
      rng,
      nonce,
      label: environment.slug,
    });
    await stageRedisDepth(
      organizationId,
      environment.id,
      mode === "calm" ? CALM.pendingDepth : STORY.pending,
      environment.slug
    );
  }

  await optimizeRollups(ch);
  await ch.close();

  // Prod is the environment the transcripts cite and the one the watch is armed on.
  await printLiveSeverity(environments[0], environments[0].slug);
  console.log(
    mode === "calm"
      ? `\nRecovered. A running heartbeat picks the calm mode up on its next tick; the report's
7d baselines are cached in the dev server for 5 minutes, so a stale "normal" column can
lag the flip by that much.`
      : `\nDegraded again. A running heartbeat picks the degraded mode up on its next tick.`
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Heartbeat: keep the stand from ageing
// ---------------------------------------------------------------------------

/**
 * A seeded stand ages. The health report's liveness finding measures how far
 * behind the freshest telemetry is, so within the hour a stand that was seeded
 * once reads as stale — `facts.trustworthy` flips and every other number on the
 * card is caveated. Heartbeat mode fixes that by appending a thin slice of
 * *now* on every tick, to both environments:
 *
 * - a handful of completed runs at roughly the calm baseline rate, in Postgres
 *   *and* ClickHouse, so the runs telemetry has a current timestamp and the top
 *   of the runs list still hydrates (a ClickHouse-only trickle empties page 1
 *   within a few ticks);
 * - the tick's worth of 10-second queue-metric buckets with the gauges still
 *   pinned at the ceiling and the backlog held where the seed left it, so flow
 *   keeps telling the same story instead of quietly recovering;
 * - the live env-queue depth in Redis, if something has emptied it;
 * - the executing cast run's `updatedAt`, so a run that has been busy for hours
 *   doesn't look abandoned in a list ordered by it.
 *
 * The counter odometers restart at zero in a fresh heartbeat process, which the
 * rollup reads as a counter reset and handles — so the trickle's arrival and
 * completion rates are the *trickle's* rates, not the seed's. The pinned story
 * is carried by the gauges (running vs limit, queued depth), which is where the
 * cause tree reads it from. What does decay is the run-derived arrival rate: as
 * the seeded spike hour ages out of the live window, throughput settles to the
 * trickle. Re-run the full seed when you want the arrival-spike figures back.
 *
 * Every trickle run is tagged `seed:heartbeat`, which is how the per-tick prune
 * finds its own Postgres rows once they pass `HEARTBEAT_RETENTION_HOURS` and
 * nothing else — the cast and the seeded recent runs carry no such tag.
 *
 * Ticks only ever append (bar that prune), so Ctrl-C at any point leaves a valid
 * stand.
 *
 * Which story a tick writes comes from the mode file, re-read every tick: `degraded`
 * (the default) pins the gauges as above, `calm` writes a healthy env and stops failing
 * runs. `--recover` / `--degrade` set it.
 */
/**
 * Half the liveness finding's 60s "fresh" threshold. The reported age runs a
 * little ahead of the cadence — buckets are floored to 10s and the report caches
 * its queries — so a 45s tick measured ~50s and grazed the boundary. 30s keeps
 * the finding green with room to spare, and a tick is ~100ms. (Trust is a
 * separate, looser gate: `facts.trustworthy` only flips past 5 minutes.)
 */
const HEARTBEAT_INTERVAL_SEC = 30;
/** The rate the trickle runs at, per environment, before per-env scaling. */
const HEARTBEAT_RUNS_PER_MIN = STORY.baselineRunsPerMin;
/**
 * Stamped on every trickle run so the prune can find its own rows and nothing
 * else. The cast and the seeded recent runs carry no such tag, so they can never
 * be caught by it however long a heartbeat runs.
 */
const HEARTBEAT_TAG = "seed:heartbeat";
/** How long a trickle run stays in Postgres before the prune collects it. */
const HEARTBEAT_RETENTION_HOURS = 24;
/** Prune cadence, in ticks. ~10 minutes at a 30s tick. */
const HEARTBEAT_PRUNE_EVERY_TICKS = 20;

type HeartbeatEnv = {
  environment: { id: string; slug: string; type: SeededEnvType };
  ids: ChIds;
  projectId: string;
  /** The seeded deployment's worker, so trickle runs are locked to a version. */
  workerId: string | null;
  emit: ReturnType<typeof createBucketEmitter>;
  runsPerTick: number;
  /** Next per-environment run number, so the list's numbering keeps climbing. */
  nextRunNumber: number;
  /** The cast's still-executing run, whose `updatedAt` each tick touches. */
  executingRunId: string | null;
};

/** One minute of runs and buckets, appended to one environment. */
async function heartbeatTick(
  ch: ClickHouse,
  env: HeartbeatEnv,
  now: number,
  rng: () => number,
  nonce: string,
  tick: number,
  mode: HeartbeatMode
): Promise<{ runs: number; metricRows: number; pruned: number }> {
  const { ids, environment } = env;

  // Runs: a healthy mix landing across the tick just gone. Nothing fails in calm mode —
  // a recovered stand shouldn't keep minting error occurrences.
  const specs: RunSpec[] = [];
  for (let i = 0; i < env.runsPerTick; i++) {
    const created =
      now -
      HEARTBEAT_INTERVAL_SEC * 1000 +
      Math.floor((i / env.runsPerTick) * (HEARTBEAT_INTERVAL_SEC - 5) * 1000);
    const failing = mode === "degraded" && rng() < STORY.baselineFailureRate;
    const task = failing ? { id: TASK_ID, queue: QUEUE } : VOLUME_TASKS[i % VOLUME_TASKS.length];
    specs.push(
      makeRunSpec({
        created,
        task: task.id,
        queue: task.queue,
        status: failing ? "COMPLETED_WITH_ERRORS" : "COMPLETED_SUCCESSFULLY",
        waitMs: lognormal(STORY.calmWaitMedianMs, STORY.waitSigma, rng),
        durationMs: lognormal(STORY.durationMedianMs, STORY.waitSigma, rng),
        failing,
        tags: [HEARTBEAT_TAG],
      })
    );
  }

  // Postgres first, and for every trickle run — not just the volume treatment the
  // seed's bulk rows get. The trickle lands at the very top of the runs list, and
  // the list drops ClickHouse ids it can't hydrate from Postgres, so a
  // ClickHouse-only trickle empties page 1 within a few ticks.
  const runIdByFriendlyId = await insertPostgresRuns(specs, {
    projectId: env.projectId,
    environmentId: environment.id,
    organizationId: ids.organization_id,
    workerId: env.workerId,
    environmentType: environment.type,
    startNumber: env.nextRunNumber,
  });
  env.nextRunNumber += specs.length;

  const runRows = specs.map((spec) =>
    taskRunRow(spec, runIdByFriendlyId.get(spec.friendlyId)!, ids, String(now), environment.type)
  );
  await insertTaskRuns(ch, runRows, `${nonce}:${environment.slug}:tick${tick}:runs`);

  // Buckets: the last minute at the live resolution. In degraded mode the gauges stay
  // pinned and the backlog jitters by a fraction of a percent, so it reads as live rather
  // than frozen without moving the number the card quotes. In calm mode the same emitter
  // writes a healthy env instead — a quarter of the ceiling, an empty queue, no throttling.
  const bucketsPerTick = Math.ceil(HEARTBEAT_INTERVAL_SEC / BUCKET_SEC);
  const nowBucket = Math.floor(now / 1000 / BUCKET_SEC) * BUCKET_SEC * 1000;
  const runsPerMin = (env.runsPerTick * 60) / HEARTBEAT_INTERVAL_SEC;
  const metricRows: QueueMetricsRawV1Input[] = [];
  for (let b = 0; b < bucketsPerTick; b++) {
    const bucketMs = nowBucket - (bucketsPerTick - 1 - b) * BUCKET_SEC * 1000;
    metricRows.push(
      ...env.emit(
        bucketMs,
        mode === "calm"
          ? // progress 1: the backlog sits at its floor, so a calm series can never
            // read as "pending increasing".
            calmBucketShape(1, runsPerMin, rng)
          : {
              envRunning: STORY.envConcurrencyLimit,
              envQueued: Math.round(STORY.pending * (0.995 + rng() * 0.01)),
              startedPerQueue: (env.runsPerTick * BUCKET_SEC) / 60,
              arrivalsPerQueue: (env.runsPerTick * BUCKET_SEC) / 60,
              waitMedianMs: STORY.pinnedWaitMedianMs,
              throttled: true,
              waitSamples: LIVE_WAIT_SAMPLES,
            }
      )
    );
  }
  await insertQueueMetrics(ch, metricRows, `${nonce}:${environment.slug}:tick${tick}:metrics`);

  // The runs list can order by `updatedAt`; a run that has been "executing" for
  // hours without its row moving looks abandoned rather than busy.
  if (env.executingRunId) {
    await prisma.taskRun.update({
      where: { id: env.executingRunId },
      data: { updatedAt: new Date(now) },
    });
  }

  // Prune the trickle's own Postgres rows once they're a day old, so a heartbeat
  // left running for a week doesn't grow the table without bound. Scoped by the
  // tag AND the age, so the cast and the seeded recent runs are untouchable.
  // Nothing can be collectable more often than the retention window, so this runs
  // on a slow cadence rather than every tick.
  let pruned = 0;
  if (tick % HEARTBEAT_PRUNE_EVERY_TICKS === 1) {
    ({ count: pruned } = await prisma.taskRun.deleteMany({
      where: {
        runtimeEnvironmentId: environment.id,
        runTags: { has: HEARTBEAT_TAG },
        createdAt: { lt: new Date(now - HEARTBEAT_RETENTION_HOURS * 3600_000) },
      },
    }));
  }

  return { runs: runRows.length, metricRows: metricRows.length, pruned };
}

async function runHeartbeat(scale: number) {
  const user = await prisma.user.findFirst({ where: { email: "local@trigger.dev" } });
  if (!user) {
    console.error("User local@trigger.dev not found. Run `pnpm run db:seed` first.");
    process.exit(1);
  }

  // Heartbeat runs on top of an existing stand and never wipes, so it looks the
  // world up instead of creating it.
  const project = await prisma.project.findFirst({ where: { externalRef: PROJECT_REF } });
  if (!project) {
    console.error(
      `No "${PROJECT_NAME}" project found. Run the full seed first:\n` +
        `  pnpm --filter webapp run db:seed:agent-examples`
    );
    process.exit(1);
  }
  const organizationId = project.organizationId;

  const ch = clickhouse();
  const rng = mulberry32(Date.now() & 0xffff);
  const nonce = `agentex-hb-${Date.now()}`;

  const envs: HeartbeatEnv[] = [];
  for (const type of ENV_TYPES) {
    const environment = await prisma.runtimeEnvironment.findFirst({
      where: { projectId: project.id, type },
    });
    if (!environment) {
      console.error(`No ${type} environment on project ${project.slug}.`);
      process.exit(1);
    }
    const ids: ChIds = {
      organization_id: organizationId,
      project_id: project.id,
      environment_id: environment.id,
    };
    const executing = await prisma.taskRun.findFirst({
      where: { runtimeEnvironmentId: environment.id, status: "EXECUTING" },
      select: { id: true },
    });
    if (!executing) {
      console.warn(
        `[${environment.slug}] no executing run found — is this stand seeded? Continuing anyway.`
      );
    }
    // Trickle runs are locked to the seeded deployment, like every other run on
    // the stand, so the list's version column isn't blank for the newest rows.
    const worker = await prisma.backgroundWorker.findFirst({
      where: { runtimeEnvironmentId: environment.id, version: DEPLOYMENT_VERSION },
      select: { id: true },
    });
    const highestNumber = await prisma.taskRun.aggregate({
      where: { runtimeEnvironmentId: environment.id },
      _max: { number: true },
    });
    envs.push({
      environment: { id: environment.id, slug: environment.slug, type: type as SeededEnvType },
      ids,
      projectId: project.id,
      workerId: worker?.id ?? null,
      nextRunNumber: (highestNumber._max.number ?? 0) + 1,
      emit: createBucketEmitter(ids, Date.now(), rng),
      runsPerTick: Math.max(
        1,
        Math.round(
          HEARTBEAT_RUNS_PER_MIN *
            (HEARTBEAT_INTERVAL_SEC / 60) *
            scale *
            (type === "PRODUCTION" ? 1 : DEV_SCALE_FACTOR)
        )
      ),
      executingRunId: executing?.id ?? null,
    });
  }

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log("\nStopped. The stand is intact — ticks only append.");
    await ch.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let mode = readHeartbeatMode();
  console.log(
    `Heartbeat every ${HEARTBEAT_INTERVAL_SEC}s in "${mode}" mode for ${envs
      .map((env) => `${env.environment.slug} ${env.runsPerTick} runs/tick`)
      .join(", ")}. Ctrl-C to stop.
Mode is re-read from ${HEARTBEAT_MODE_FILE} every tick — write "calm" or "degraded" there
(or run --recover / --degrade) to flip the story without a restart.`
  );

  for (let tick = 1; !stopping; tick++) {
    const started = Date.now();
    // Re-read every tick: a flip is a file write from another process, and a heartbeat that
    // only read it at boot would overwrite the recovery 30 seconds later.
    const current = readHeartbeatMode();
    if (current !== mode) {
      console.log(`Mode changed: ${mode} -> ${current}`);
      mode = current;
    }
    const counts: string[] = [];
    for (const env of envs) {
      const result = await heartbeatTick(ch, env, started, rng, nonce, tick, mode);
      counts.push(
        `${env.environment.slug} +${result.runs} runs +${result.metricRows} metric rows` +
          (result.pruned > 0 ? ` -${result.pruned} pruned` : "")
      );
    }
    await refreshRedisDepth(
      organizationId,
      envs,
      mode === "calm" ? CALM.pendingDepth : STORY.pending
    );
    console.log(
      `[${new Date(started).toISOString().slice(11, 19)}] tick ${tick} ${mode} · ${counts.join(
        " · "
      )} · ${Date.now() - started}ms`
    );
    if (stopping) break;
    await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_INTERVAL_SEC * 1000));
  }
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
  --heartbeat    don't seed — keep running and append a minute of fresh rows to
                 both environments every ${HEARTBEAT_INTERVAL_SEC}s, so the health report never ages
                 into "stale telemetry". Runs on top of an existing stand and
                 never wipes; Ctrl-C leaves it intact. Writes the story named by
                 the mode file, re-read every tick.
  --recover      one-shot: flip both environments to healthy. Clears the last
                 ${FLIP_LOOKBACK_HOURS}h of queue metrics, writes ${CALM.windowMinutes}m of calm buckets ending now,
                 drops the live queue depth, sets the mode file to "calm", then
                 prints the live report's severity. The 7d baseline is untouched,
                 so the recovered report is still trustworthy.
  --degrade      one-shot: flip back. Rewrites ${DEGRADE_WINDOW_MINUTES}m of pinned buckets, restores the
                 queue depth, sets the mode file to "degraded", and purges pinned
                 buckets a long heartbeat has pushed into the 7d baseline (without
                 that the spike is measured against itself and reads normal).
  --reset-only   delete everything this seeder owns and exit
  --help         this text

Mode file: ${HEARTBEAT_MODE_FILE}
               "degraded" (default when absent) or "calm".`);
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

  // Before anything destructive: these all run on top of an existing stand.
  if (flags.heartbeat === "true") {
    await runHeartbeat(scale);
    return;
  }
  if (flags.recover === "true" && flags.degrade === "true") {
    console.error("--recover and --degrade are opposites; pass one.");
    process.exit(1);
  }
  if (flags.recover === "true") {
    await runFlip("calm", scale);
    return;
  }
  if (flags.degrade === "true") {
    await runFlip("degraded", scale);
    return;
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

  // A fresh seed is the degraded story, so a heartbeat left in calm mode by an earlier
  // --recover doesn't quietly flatten it on its next tick.
  writeHeartbeatMode("degraded");

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
