import { prisma } from "./app/db.server";
import { createOrganization } from "./app/models/organization.server";
import { createProject } from "./app/models/project.server";
import { ClickHouse } from "@internal/clickhouse";
import type { QueueMetricsRawV1Input } from "@internal/clickhouse";
import { generateFriendlyId } from "./app/v3/friendlyIdentifiers";

// Queue metrics simulator: writes realistic raw rows into a synthetic tenant's
// queue_metrics_raw_v1 and lets the MV build queue_metrics_v1 (the same path the real
// consumer uses), so the dashboard can be built without the run engine. See TRI-10407.

const ORG_TITLE = "Queue Metrics Dev";
const PROJECT_NAME = "queue-metrics-demo";

type Rng = () => number;
type QueueProfile = {
  name: string;
  limit: (bucket: number) => number;
  arrivals: (bucket: number, rng: Rng) => number; // expected new runs enqueued this bucket
  waitBaseMs: number;
  sparse?: boolean; // emit no rows when the queue is fully idle (tests carry-forward gaps)
};
type Scenario = {
  description: string;
  envLimit: (bucket: number) => number;
  queues: QueueProfile[];
};

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n && !n.startsWith("--")) {
        flags[k] = n;
        i++;
      } else flags[k] = "true";
    }
  }
  return flags;
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)\s*(s|m|h|d)?$/);
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[unit]!;
}

// ---------------------------------------------------------------------------
// Deterministic RNG + distributions
// ---------------------------------------------------------------------------

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(rng: Rng): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function lognormal(medianMs: number, sigma: number, rng: Rng): number {
  return Math.exp(Math.log(Math.max(medianMs, 1)) + sigma * standardNormal(rng));
}

function poisson(lambda: number, rng: Rng): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + standardNormal(rng) * Math.sqrt(lambda)));
  const L = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng();
  } while (p > L);
  return k - 1;
}

function formatChDateTime(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const steady = (): QueueProfile[] => [
  { name: "emails", limit: () => 20, arrivals: (_b, r) => poisson(12, r), waitBaseMs: 40 },
  { name: "webhooks", limit: () => 15, arrivals: (_b, r) => poisson(9, r), waitBaseMs: 40 },
  { name: "reports", limit: () => 10, arrivals: (_b, r) => poisson(5, r), waitBaseMs: 60 },
];

// periodic bursts every ~30 buckets
const bursty = (name: string, limit: number, base: number): QueueProfile => ({
  name,
  limit: () => limit,
  arrivals: (b, r) => poisson(b % 30 < 4 ? base * 5 : base, r),
  waitBaseMs: 50,
});

const scenarios: Record<string, (totalBuckets: number, bucketSec: number) => Scenario> = {
  steady: () => ({
    description: "all queues below capacity, no throttling",
    envLimit: () => 60,
    queues: steady(),
  }),

  burst: () => ({
    description: "periodic arrival bursts -> backlog + wait spikes + throttling",
    envLimit: () => 60,
    queues: [bursty("ingest", 20, 6), bursty("transform", 20, 7)],
  }),

  // Tela case: sum of per-queue limits far exceeds the env limit, so queues compete.
  "over-allocated-env": () => ({
    description: "Sum(queue limits)=120 >> env limit=40; env saturates, queues env-limited",
    envLimit: () => 40,
    queues: Array.from({ length: 6 }, (_v, i) => ({
      name: `worker-${i + 1}`,
      limit: () => 20,
      arrivals: (_b: number, r: Rng) => poisson(14, r),
      waitBaseMs: 50,
    })),
  }),

  "single-queue-starves-others": () => ({
    description: "one greedy queue consumes most of a small env limit, starving the rest",
    envLimit: () => 30,
    queues: [
      { name: "greedy", limit: () => 40, arrivals: (_b, r) => poisson(45, r), waitBaseMs: 60 },
      { name: "polite-1", limit: () => 10, arrivals: (_b, r) => poisson(6, r), waitBaseMs: 50 },
      { name: "polite-2", limit: () => 10, arrivals: (_b, r) => poisson(6, r), waitBaseMs: 50 },
    ],
  }),

  "throttled-backlog": () => ({
    description:
      "arrival rate persistently above the queue limit -> permanent backlog + throttling",
    envLimit: () => 50,
    queues: [
      { name: "overloaded", limit: () => 10, arrivals: (_b, r) => poisson(16, r), waitBaseMs: 80 },
    ],
  }),

  "idle-sparse": () => ({
    description: "sparse arrivals with many empty buckets (carry-forward gaps)",
    envLimit: () => 50,
    queues: Array.from({ length: 4 }, (_v, i) => ({
      name: `sparse-${i + 1}`,
      limit: () => 5,
      arrivals: (_b: number, r: Rng) => (r() < 0.12 ? poisson(3, r) : 0),
      waitBaseMs: 30,
      sparse: true,
    })),
  }),

  "spike-then-drain": (totalBuckets) => ({
    description: "heavy arrivals for the first third, then zero; backlog builds then drains",
    envLimit: () => 60,
    queues: [
      {
        name: "batch-job",
        limit: () => 15,
        arrivals: (b, r) => (b < totalBuckets / 3 ? poisson(30, r) : 0),
        waitBaseMs: 70,
      },
    ],
  }),

  // Default: one env with a variety of queue behaviours + occasional env saturation.
  mixed: (totalBuckets) => ({
    description: "variety of queue profiles in one env, with occasional env saturation",
    envLimit: (b) => (b % 40 < 12 ? 45 : 70), // dips low periodically to flip env saturation
    queues: [
      { name: "emails", limit: () => 20, arrivals: (_b, r) => poisson(12, r), waitBaseMs: 40 },
      bursty("webhooks", 20, 6),
      { name: "reports", limit: () => 10, arrivals: (_b, r) => poisson(8, r), waitBaseMs: 80 },
      {
        name: "cleanup",
        limit: () => 5,
        arrivals: (_b, r) => (r() < 0.12 ? poisson(3, r) : 0),
        waitBaseMs: 30,
        sparse: true,
      },
      {
        name: "nightly-batch",
        limit: () => 15,
        arrivals: (b, r) => (b < totalBuckets / 5 ? poisson(18, r) : 0),
        waitBaseMs: 70,
      },
    ],
  }),
};

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

type Ids = { organization_id: string; project_id: string; environment_id: string };
const WAIT_SIGMA = 0.6;
const NACK_RATE = 0.02;
const DLQ_RATE = 0.004;

// Advance one bucket of the simulation for every queue, returning the raw rows to insert.
// `backlog` is mutated in place so state carries across buckets (and into live mode).
function simulateBucket(
  scenario: Scenario,
  bucket: number,
  bucketSec: number,
  eventTime: string,
  ids: Ids,
  backlog: number[],
  rng: Rng
): QueueMetricsRawV1Input[] {
  const envLimit = scenario.envLimit(bucket);
  const n = scenario.queues.length;

  const limit = new Array(n);
  const desired = new Array(n);
  for (let q = 0; q < n; q++) {
    limit[q] = scenario.queues[q].limit(bucket);
    const arrivals = Math.min(500, scenario.queues[q].arrivals(bucket, rng));
    const prior = backlog[q]; // backlog carried from earlier buckets, before this bucket's arrivals
    backlog[q] += arrivals; // arrivals join the backlog; recorded as enqueues below
    (desired as any)[q] = { arrivals, prior, want: Math.min(limit[q], backlog[q]) };
  }

  // Env cap: if the queues collectively want more concurrency than the env allows, scale down.
  const sumWant = desired.reduce((s: number, d: any) => s + d.want, 0);
  const scale = sumWant > envLimit && sumWant > 0 ? envLimit / sumWant : 1;

  const running = new Array(n);
  const queued = new Array(n);
  let envRunning = 0;
  let envQueued = 0;
  for (let q = 0; q < n; q++) {
    const d = desired[q] as any;
    running[q] = Math.floor(d.want * scale);
    queued[q] = backlog[q] - running[q];
    envRunning += running[q];
    envQueued += queued[q];
  }

  const rows: QueueMetricsRawV1Input[] = [];
  for (let q = 0; q < n; q++) {
    const profile = scenario.queues[q];
    const started = running[q];
    const arrivals = (desired[q] as any).arrivals as number;
    const prior = (desired[q] as any).prior as number; // depth a starting run actually queued behind
    backlog[q] = queued[q]; // carry the unserved remainder forward

    if (profile.sparse && arrivals === 0 && started === 0 && prior === 0) {
      continue; // fully idle: leave a gap so carry-forward is exercised
    }

    const gauge: QueueMetricsRawV1Input = {
      ...ids,
      queue_name: profile.name,
      event_time: eventTime,
      op: "gauge",
      running: running[q],
      queued: queued[q],
      queue_limit: limit[q],
      env_running: envRunning,
      env_queued: envQueued,
      env_limit: envLimit,
      throttled: running[q] >= limit[q] && queued[q] > 0 ? 1 : 0,
    };
    rows.push(gauge);

    for (let a = 0; a < arrivals; a++) {
      rows.push({ ...ids, queue_name: profile.name, event_time: eventTime, op: "enqueue" });
    }

    const medianWait = profile.waitBaseMs + (prior / Math.max(limit[q], 1)) * bucketSec * 1000;
    for (let s = 0; s < started; s++) {
      rows.push({
        ...ids,
        queue_name: profile.name,
        event_time: eventTime,
        op: "started",
        wait_ms: Math.round(lognormal(medianWait, WAIT_SIGMA, rng)),
      });
      const roll = rng();
      const op = roll < DLQ_RATE ? "dlq" : roll < DLQ_RATE + NACK_RATE ? "nack" : "ack";
      rows.push({ ...ids, queue_name: profile.name, event_time: eventTime, op });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// ClickHouse
// ---------------------------------------------------------------------------

function clickhouse(): ClickHouse {
  const clickhouseUrl = process.env.CLICKHOUSE_URL ?? process.env.EVENTS_CLICKHOUSE_URL;
  if (!clickhouseUrl) {
    console.error("CLICKHOUSE_URL not set");
    process.exit(1);
  }
  if (/\.clickhouse\.cloud|prod/i.test(clickhouseUrl)) {
    console.error(`Refusing to run against a non-local ClickHouse: ${clickhouseUrl}`);
    process.exit(1);
  }
  const url = new URL(clickhouseUrl);
  url.searchParams.delete("secure");
  return new ClickHouse({ url: url.toString(), name: "queue-metrics-simulator" });
}

async function insertBatched(ch: ClickHouse, rows: QueueMetricsRawV1Input[], nonce: string) {
  const BATCH = 25_000;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const [error] = await ch.queueMetrics.insertRaw(slice, {
      params: { clickhouse_settings: { insert_deduplication_token: `${nonce}:${i}` } },
    });
    if (error) {
      console.error("insert failed:", error.message);
      process.exit(1);
    }
  }
}

async function resetEnv(ch: ClickHouse, environmentId: string) {
  const raw = (
    ch.writer as unknown as { client: { command: (a: { query: string }) => Promise<unknown> } }
  ).client;
  for (const table of ["queue_metrics_raw_v1", "queue_metrics_v1"]) {
    await raw.command({
      query: `DELETE FROM trigger_dev.${table} WHERE environment_id = '${environmentId}'`,
    });
  }
  console.log(`Reset queue metrics for environment ${environmentId}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Make the synthetic project a V2 engine project with a current dev worker + a Postgres
// TaskQueue per simulated queue, so the /queues list renders the V2 table (it pages from
// Postgres and gates on engine version; ClickHouse only holds the metrics).
async function ensureTaskQueues(
  scenario: Scenario,
  projectId: string,
  runtimeEnvironmentId: string
) {
  await prisma.project.update({ where: { id: projectId }, data: { engine: "V2" } });

  await prisma.backgroundWorker.upsert({
    where: {
      projectId_runtimeEnvironmentId_version: {
        projectId,
        runtimeEnvironmentId,
        version: "queue-metrics-sim",
      },
    },
    update: {},
    create: {
      friendlyId: generateFriendlyId("worker"),
      engine: "V2",
      contentHash: "queue-metrics-sim",
      sdkVersion: "4.0.0",
      cliVersion: "4.0.0",
      projectId,
      runtimeEnvironmentId,
      version: "queue-metrics-sim",
      metadata: {},
    },
  });

  for (const profile of scenario.queues) {
    const concurrencyLimit = profile.limit(0);
    await prisma.taskQueue.upsert({
      where: { runtimeEnvironmentId_name: { runtimeEnvironmentId, name: profile.name } },
      create: {
        friendlyId: generateFriendlyId("queue"),
        version: "V2",
        name: profile.name,
        orderableName: profile.name,
        concurrencyLimit,
        runtimeEnvironmentId,
        projectId,
        type: "NAMED",
      },
      update: { concurrencyLimit },
    });
  }
  console.log(`Ensured ${scenario.queues.length} task queues in Postgres.`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const scenarioName = flags.scenario ?? "mixed";
  const build = scenarios[scenarioName];
  if (!build) {
    console.error(
      `Unknown scenario "${scenarioName}". Options: ${Object.keys(scenarios).join(", ")}`
    );
    process.exit(1);
  }
  const bucketSec = Number(flags.bucket ?? 10);
  const windowSec = parseDuration(flags.window ?? "2h");
  const totalBuckets = Math.floor(windowSec / bucketSec);
  const seed = Number(flags.seed ?? 1);
  const live = flags.live === "true";

  const user = await prisma.user.findUnique({ where: { email: "local@trigger.dev" } });
  if (!user) {
    console.error("User local@trigger.dev not found. Run `pnpm run db:seed` first.");
    process.exit(1);
  }

  let org = await prisma.organization.findFirst({
    where: { title: ORG_TITLE, members: { some: { userId: user.id } } },
  });
  if (!org)
    org = await createOrganization({ title: ORG_TITLE, userId: user.id, companySize: "1-10" });

  let project = await prisma.project.findFirst({
    where: { name: PROJECT_NAME, organizationId: org.id },
  });
  if (!project) {
    project = await createProject({
      organizationSlug: org.slug,
      name: PROJECT_NAME,
      userId: user.id,
      version: "v3",
    });
  }

  const runtimeEnv = await prisma.runtimeEnvironment.findFirst({
    where: { projectId: project.id, type: "DEVELOPMENT" },
  });
  if (!runtimeEnv) {
    console.error("No DEVELOPMENT environment found for project.");
    process.exit(1);
  }

  const ids: Ids = {
    organization_id: org.id,
    project_id: project.id,
    environment_id: runtimeEnv.id,
  };
  const ch = clickhouse();
  const nonce = `qmsim-${Date.now()}-${seed}`;

  if (flags.reset === "true" || flags["reset-only"] === "true") {
    await resetEnv(ch, runtimeEnv.id);
    if (flags["reset-only"] === "true") {
      await ch.close();
      process.exit(0);
    }
  }

  const scenario = build(totalBuckets, bucketSec);
  await ensureTaskQueues(scenario, project.id, runtimeEnv.id);
  const rng = mulberry32(seed);
  const backlog = new Array(scenario.queues.length).fill(0);

  console.log(`Scenario "${scenarioName}": ${scenario.description}`);
  console.log(
    `Backfilling ${totalBuckets} x ${bucketSec}s buckets (${flags.window ?? "2h"}) for ${scenario.queues.length} queues...`
  );

  // Backfill: buckets from (now - window) up to now, aligned to the bucket grid.
  const nowBucket = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec;
  const startBucket = nowBucket - totalBuckets * bucketSec;
  const rows: QueueMetricsRawV1Input[] = [];
  for (let b = 0; b < totalBuckets; b++) {
    const eventTime = formatChDateTime(new Date((startBucket + b * bucketSec) * 1000));
    rows.push(...simulateBucket(scenario, b, bucketSec, eventTime, ids, backlog, rng));
  }
  await insertBatched(ch, rows, nonce);
  console.log(`Inserted ${rows.length} raw rows.`);

  // Merge the AggregatingMergeTree partials so argMax "current value" widgets read cleanly.
  // The real pipeline relies on background merges; the simulator forces it for a tidy demo.
  const raw = (
    ch.writer as unknown as { client: { command: (a: { query: string }) => Promise<unknown> } }
  ).client;
  await raw.command({ query: `OPTIMIZE TABLE trigger_dev.queue_metrics_v1 FINAL` });

  const origin = process.env.APP_ORIGIN ?? "http://localhost:3030";
  console.log(
    `\nQueues dashboard: ${origin}/orgs/${org.slug}/projects/${project.slug}/env/dev/dashboards/queues`
  );

  if (live) {
    console.log(`\nLive mode: appending one bucket every ${bucketSec}s (Ctrl-C to stop)...`);
    let b = totalBuckets;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((r) => setTimeout(r, bucketSec * 1000));
      const eventTime = formatChDateTime(
        new Date(Math.floor(Date.now() / 1000 / bucketSec) * bucketSec * 1000)
      );
      const liveRows = simulateBucket(scenario, b, bucketSec, eventTime, ids, backlog, rng);
      await insertBatched(ch, liveRows, `${nonce}:live:${b}`);
      console.log(`bucket ${b}: ${liveRows.length} rows @ ${eventTime}`);
      b++;
    }
  }

  await ch.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
