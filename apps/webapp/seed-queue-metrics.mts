import { boundedIn } from "@trigger.dev/database";
import { ClickHouse } from "@internal/clickhouse";
import type { QueueMetricsRawV1Input } from "@internal/clickhouse";
// App modules compile to CommonJS under tsx, so these intentionally use default bindings.
// oxlint-disable import/default
import dbServer from "./app/db.server";
import organizationServer from "./app/models/organization.server";
import projectServer from "./app/models/project.server";
import friendlyIdentifiers from "./app/v3/friendlyIdentifiers";
// oxlint-enable import/default

const { prisma } = dbServer;
const { createOrganization } = organizationServer;
const { createProject } = projectServer;
const { generateFriendlyId } = friendlyIdentifiers;

// Writes raw rows into queue_metrics_raw_v1 and lets the MVs build the rollups. See TRI-10407.

const ORG_TITLE = "Queue Metrics Dev";
const PROJECT_NAME = "queue-metrics-demo";

type Rng = () => number;
type QueueProfile = {
  name: string;
  limit: (bucket: number) => number;
  arrivals: (bucket: number, rng: Rng) => number;
  waitBaseMs: number;
  sparse?: boolean;
  ck?: {
    backlogged: (bucket: number, rng: Rng) => number;
    maxWaitMs: (bucket: number, rng: Rng) => number;
  };
};
type Scenario = {
  description: string;
  envLimit: (bucket: number) => number;
  queues: QueueProfile[];
};

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

const steady = (): QueueProfile[] => [
  { name: "emails", limit: () => 20, arrivals: (_b, r) => poisson(12, r), waitBaseMs: 40 },
  { name: "webhooks", limit: () => 15, arrivals: (_b, r) => poisson(9, r), waitBaseMs: 40 },
  { name: "reports", limit: () => 10, arrivals: (_b, r) => poisson(5, r), waitBaseMs: 60 },
];

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

  "many-queues": () => ({
    description:
      "61 queues: one runaway, busy head, bursty middle, long sparse tail (pagination + ranking)",
    envLimit: () => 150,
    queues: [
      { name: "imports", limit: () => 8, arrivals: (_b, r) => poisson(14, r), waitBaseMs: 80 },
      ...["checkout", "notifications", "emails"].map((name, i) => ({
        name,
        limit: () => 15,
        arrivals: (_b: number, r: Rng) => poisson(7 + i, r),
        waitBaseMs: 60,
      })),
      ...Array.from({ length: 12 }, (_v, i) =>
        bursty(`service-${String(i + 1).padStart(2, "0")}`, 10, 2)
      ),
      ...Array.from({ length: 20 }, (_v, i) => ({
        name: `job-${String(i + 1).padStart(2, "0")}`,
        limit: () => 5,
        arrivals: (_b: number, r: Rng) => poisson(1, r),
        waitBaseMs: 40,
      })),
      ...Array.from({ length: 25 }, (_v, i) => ({
        name: `tenant-${String(i + 1).padStart(2, "0")}`,
        limit: () => 3,
        arrivals: (_b: number, r: Rng) => (r() < 0.05 ? poisson(2, r) : 0),
        waitBaseMs: 30,
        sparse: true,
      })),
    ],
  }),

  "tenant-hotspot": () => ({
    description:
      "CK queue where a hog tenant starves others: CK charts + live key table (use --usage)",
    envLimit: () => 40,
    queues: [
      {
        name: "per-tenant",
        limit: () => 10,
        arrivals: (b, r) => poisson(b % 60 < 20 ? 25 : 8, r),
        waitBaseMs: 60,
        ck: {
          backlogged: (b, r) => (b % 60 < 20 ? 6 + Math.round(r() * 6) : Math.round(r() * 3)),
          maxWaitMs: (b, r) =>
            b % 60 < 20
              ? Math.round(lognormal(90_000, 0.5, r))
              : Math.round(lognormal(3_000, 0.6, r)),
        },
      },
      { name: "background", limit: () => 10, arrivals: (_b, r) => poisson(5, r), waitBaseMs: 40 },
    ],
  }),

  mixed: (totalBuckets) => ({
    description: "variety of queue profiles in one env, with occasional env saturation",
    envLimit: (b) => (b % 40 < 12 ? 45 : 70),
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

type Ids = { organization_id: string; project_id: string; environment_id: string };
const WAIT_SIGMA = 0.6;
const NACK_RATE = 0.02;
const DLQ_RATE = 0.004;

type CounterOp = "enqueue" | "started" | "ack" | "nack" | "dlq";
// Cumulative odometers: the first reading must be cum=0 so deltaSumTimestamp sees the 0->1 delta.
type CounterState = Record<CounterOp, number>[];

function counterRows(
  counters: CounterState,
  q: number,
  ids: Ids,
  queueName: string,
  eventTime: string,
  orderKey: () => number,
  op: CounterOp,
  wait_ms?: number
): QueueMetricsRawV1Input[] {
  const rows: QueueMetricsRawV1Input[] = [];
  if (counters[q][op] === 0) {
    rows.push({
      ...ids,
      queue_name: queueName,
      event_time: eventTime,
      op,
      cumulative: 0,
      order_key: orderKey(),
    });
  }
  counters[q][op] += 1;
  rows.push({
    ...ids,
    queue_name: queueName,
    event_time: eventTime,
    op,
    cumulative: counters[q][op],
    order_key: orderKey(),
    ...(wait_ms !== undefined ? { wait_ms } : {}),
  });
  return rows;
}

function newCounterState(n: number): CounterState {
  return Array.from({ length: n }, () => ({ enqueue: 0, started: 0, ack: 0, nack: 0, dlq: 0 }));
}

// tenant-01 is the hog here and in stageRedisUsage; keep the two in step.
const CK_TENANT_COUNT = 12;
type CkSimState = { backlog: number[]; counters: Map<number, Record<CounterOp, number>> };
const ckSim = new Map<number, CkSimState>();

function ckTenantName(t: number): string {
  return `tenant-${String(t + 1).padStart(2, "0")}`;
}

function ckCounterRows(
  state: CkSimState,
  tenant: number,
  ids: Ids,
  queueName: string,
  eventTime: string,
  orderKey: () => number,
  op: CounterOp,
  wait_ms?: number
): QueueMetricsRawV1Input[] {
  let c = state.counters.get(tenant);
  if (!c) {
    c = { enqueue: 0, started: 0, ack: 0, nack: 0, dlq: 0 };
    state.counters.set(tenant, c);
  }
  const common = {
    ...ids,
    queue_name: queueName,
    concurrency_key: ckTenantName(tenant),
    event_time: eventTime,
  };
  const rows: QueueMetricsRawV1Input[] = [];
  if (c[op] === 0) rows.push({ ...common, op, cumulative: 0, order_key: orderKey() });
  c[op] += 1;
  rows.push({
    ...common,
    op,
    cumulative: c[op],
    order_key: orderKey(),
    ...(wait_ms !== undefined ? { wait_ms } : {}),
  });
  return rows;
}

// `backlog` and `counters` are mutated in place: state carries across buckets and into live mode.
function simulateBucket(
  scenario: Scenario,
  bucket: number,
  bucketSec: number,
  eventTime: string,
  bucketEpochSec: number,
  ids: Ids,
  backlog: number[],
  counters: CounterState,
  rng: Rng
): QueueMetricsRawV1Input[] {
  const envLimit = scenario.envLimit(bucket);
  const n = scenario.queues.length;

  const limit = new Array(n);
  const desired = new Array(n);
  for (let q = 0; q < n; q++) {
    limit[q] = scenario.queues[q].limit(bucket);
    const arrivals = Math.min(500, scenario.queues[q].arrivals(bucket, rng));
    const prior = backlog[q];
    backlog[q] += arrivals;
    (desired as any)[q] = { arrivals, prior, want: Math.min(limit[q], backlog[q]) };
  }

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

  // Order keys must be monotonic across processes, so they are time-based plus a per-bucket seq.
  let bucketSeq = 0;
  const orderKey = () => bucketEpochSec * 1_000_000 + bucketSeq++;

  const rows: QueueMetricsRawV1Input[] = [];
  for (let q = 0; q < n; q++) {
    const profile = scenario.queues[q];
    const started = running[q];
    const arrivals = (desired[q] as any).arrivals as number;
    const prior = (desired[q] as any).prior as number;
    backlog[q] = queued[q];

    if (profile.sparse && arrivals === 0 && started === 0 && prior === 0) {
      continue;
    }

    const ckBacklogged = profile.ck
      ? queued[q] > 0
        ? Math.max(1, Math.min(profile.ck.backlogged(bucket, rng), queued[q]))
        : 0
      : undefined;
    const ckMaxWaitMs =
      profile.ck && ckBacklogged ? Math.round(profile.ck.maxWaitMs(bucket, rng)) : undefined;

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
      throttled: queued[q] > 0 && (running[q] >= limit[q] || scale < 1) ? 1 : 0,
      ...(ckBacklogged !== undefined
        ? { ck_backlogged: ckBacklogged, ck_max_wait_ms: ckMaxWaitMs ?? 0 }
        : {}),
    };
    rows.push(gauge);

    for (let a = 0; a < arrivals; a++) {
      rows.push(...counterRows(counters, q, ids, profile.name, eventTime, orderKey, "enqueue"));
    }

    if (profile.ck) {
      let ckq = ckSim.get(q);
      if (!ckq) {
        ckq = { backlog: new Array(CK_TENANT_COUNT).fill(0), counters: new Map() };
        ckSim.set(q, ckq);
      }
      const hogShare = bucket % 60 < 20 ? 0.6 : 0.15;
      const arrivalsPerTenant = new Array(CK_TENANT_COUNT).fill(0);
      for (let a = 0; a < arrivals; a++) {
        const t = rng() < hogShare ? 0 : 1 + Math.floor(rng() * (CK_TENANT_COUNT - 1));
        arrivalsPerTenant[t]++;
        ckq.backlog[t]++;
      }
      const drainedPerTenant = new Array(CK_TENANT_COUNT).fill(0);
      let remaining = started;
      while (remaining > 0 && ckq.backlog.some((v) => v > 0)) {
        for (let t = 0; t < CK_TENANT_COUNT && remaining > 0; t++) {
          if (ckq.backlog[t] > 0) {
            ckq.backlog[t]--;
            drainedPerTenant[t]++;
            remaining--;
          }
        }
      }
      for (let t = 0; t < CK_TENANT_COUNT; t++) {
        const fairShare = Math.max(1, limit[q] / CK_TENANT_COUNT);
        const ckMedianWait = profile.waitBaseMs + (ckq.backlog[t] / fairShare) * bucketSec * 1000;
        for (let a = 0; a < arrivalsPerTenant[t]; a++) {
          rows.push(...ckCounterRows(ckq, t, ids, profile.name, eventTime, orderKey, "enqueue"));
        }
        for (let d = 0; d < drainedPerTenant[t]; d++) {
          rows.push(
            ...ckCounterRows(
              ckq,
              t,
              ids,
              profile.name,
              eventTime,
              orderKey,
              "started",
              Math.round(lognormal(ckMedianWait, WAIT_SIGMA, rng))
            )
          );
          rows.push(...ckCounterRows(ckq, t, ids, profile.name, eventTime, orderKey, "ack"));
        }
        if (ckq.backlog[t] > 0 || drainedPerTenant[t] > 0) {
          rows.push({
            ...ids,
            queue_name: profile.name,
            concurrency_key: ckTenantName(t),
            event_time: eventTime,
            op: "gauge",
            queued: ckq.backlog[t],
            running: drainedPerTenant[t],
          });
        }
      }
    }

    const medianWait = profile.waitBaseMs + (prior / Math.max(limit[q], 1)) * bucketSec * 1000;
    for (let s = 0; s < started; s++) {
      rows.push(
        ...counterRows(
          counters,
          q,
          ids,
          profile.name,
          eventTime,
          orderKey,
          "started",
          Math.round(lognormal(medianWait, WAIT_SIGMA, rng))
        )
      );
      const roll = rng();
      const op: CounterOp = roll < DLQ_RATE ? "dlq" : roll < DLQ_RATE + NACK_RATE ? "nack" : "ack";
      rows.push(...counterRows(counters, q, ids, profile.name, eventTime, orderKey, op));
    }
  }
  return rows;
}

function clickhouse(): ClickHouse {
  const clickhouseUrl = process.env.CLICKHOUSE_URL ?? process.env.EVENTS_CLICKHOUSE_URL;
  if (!clickhouseUrl) {
    console.error("CLICKHOUSE_URL not set");
    process.exit(1);
  }
  const url = new URL(clickhouseUrl);
  // Local hosts only (this script deletes rows); never echo the URL, it carries credentials.
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (!localHosts.has(url.hostname)) {
    console.error(`Refusing to run against a non-local ClickHouse host: ${url.hostname}`);
    process.exit(1);
  }
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
  for (const table of [
    "queue_metrics_raw_v1",
    "queue_metrics_v1",
    "queue_metrics_5m_v1",
    "env_metrics_v1",
    "queue_metrics_ck_v1",
  ]) {
    await raw.command({
      query: `DELETE FROM trigger_dev.${table} WHERE environment_id = '${environmentId}'`,
    });
  }
  console.log(`Reset queue metrics for environment ${environmentId}`);
}

// Reconciled every run: staged with --usage, cleared otherwise.
async function stageRedisUsage(scenario: Scenario, ids: Ids, seed: number, clear: boolean) {
  const host = process.env.RUN_ENGINE_RUN_QUEUE_REDIS_HOST ?? process.env.REDIS_HOST ?? "localhost";
  const port = Number(
    process.env.RUN_ENGINE_RUN_QUEUE_REDIS_PORT ?? process.env.REDIS_PORT ?? 6379
  );
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (!localHosts.has(host)) {
    console.warn(`Skipping Redis usage staging on a non-local host: ${host}`);
    return;
  }
  try {
    const { createRedisClient } = await import("@internal/redis");
    const redis = createRedisClient({ host, port });
    const rng = mulberry32(seed + 1);
    const prefix = "engine:runqueue:";
    const logicalBase = `{org:${ids.organization_id}}:proj:${ids.project_id}:env:${ids.environment_id}:queue:`;
    const base = `${prefix}${logicalBase}`;

    // envQueue is a ZSET with no proj section; envCurrentDequeued is a SET with one.
    const envQueueKey = `${prefix}{org:${ids.organization_id}}:env:${ids.environment_id}`;
    const envCurrentDequeuedKey = `${prefix}{org:${ids.organization_id}}:proj:${ids.project_id}:env:${ids.environment_id}:currentDequeued`;
    await redis.del(envQueueKey, envCurrentDequeuedKey);
    // Per-queue Queued = ZCARD(base) + lengthCounter; Running = SCARD(currentDequeued).
    let envQueuedTotal = 0;
    let envRunningTotal = 0;

    for (const [q, profile] of scenario.queues.entries()) {
      const key = `${base}${profile.name}:currentDequeued`;
      await redis.del(key);

      // ckIndex members are stored unprefixed, exactly like the run-queue Lua does.
      const ckIndexKey = `${base}${profile.name}:ckIndex`;
      const lengthCounterKey = `${base}${profile.name}:lengthCounter`;
      const staleMembers = await redis.zrange(ckIndexKey, 0, -1);
      for (const member of staleMembers) {
        await redis.del(`${prefix}${member}`, `${prefix}${member}:currentConcurrency`);
      }
      await redis.del(ckIndexKey, lengthCounterKey);

      if (clear) continue;
      const limit = profile.limit(0);
      const count = profile.sparse
        ? rng() < 0.3
          ? 1
          : 0
        : q === 0
          ? limit + Math.round(rng() * 2)
          : Math.round(limit * (0.3 + 0.6 * rng()));
      if (count > 0) {
        await redis.sadd(key, ...Array.from({ length: count }, (_v, i) => `sim_run_${i}`));
      }
      envRunningTotal += count;

      if (profile.ck) {
        const now = Date.now();
        const tenants = 12;
        let totalCkQueued = 0;
        for (let t = 1; t <= tenants; t++) {
          const tenant = `tenant-${String(t).padStart(2, "0")}`;
          const member = `${logicalBase}${profile.name}:ck:${tenant}`;
          const hog = t === 1;
          const queuedCount = hog ? 40 : 1 + Math.round(rng() * 5);
          const runningCount = hog ? limit : Math.round(rng() * 2);
          const oldestAgeMs = hog ? 15 * 60_000 : 5_000 + Math.round(rng() * 55_000);
          const zargs: Array<string | number> = [];
          for (let i = 0; i < queuedCount; i++) {
            zargs.push(now - oldestAgeMs + i * 250, `sim_${tenant}_run_${i}`);
          }
          await redis.zadd(`${prefix}${member}`, ...zargs);
          if (runningCount > 0) {
            await redis.sadd(
              `${prefix}${member}:currentConcurrency`,
              ...Array.from({ length: runningCount }, (_v, i) => `sim_${tenant}_running_${i}`)
            );
          }
          await redis.zadd(ckIndexKey, now - oldestAgeMs, member);
          totalCkQueued += queuedCount;
        }
        await redis.set(lengthCounterKey, totalCkQueued, "EX", 24 * 3600);
        envQueuedTotal += totalCkQueued;
      }
    }

    // The env set/zset needs members distinct across queues to reach the summed cardinality.
    if (!clear) {
      if (envRunningTotal > 0) {
        await redis.sadd(
          envCurrentDequeuedKey,
          ...Array.from({ length: envRunningTotal }, (_v, i) => `sim_env_run_${i}`)
        );
      }
      if (envQueuedTotal > 0) {
        const now = Date.now();
        const zargs: Array<string | number> = [];
        for (let i = 0; i < envQueuedTotal; i++) zargs.push(now + i, `sim_env_queued_${i}`);
        await redis.zadd(envQueueKey, ...zargs);
      }
    }

    await redis.quit();
    console.log(
      clear
        ? "Cleared staged Redis usage."
        : "Staged fake running counts in Redis (Running column + allocation usage bars)."
    );
  } catch (error) {
    console.warn("Redis usage staging skipped:", error instanceof Error ? error.message : error);
  }
}

// The /queues list pages from Postgres and gates on engine version, so the project needs
// engine V2, a worker, and a TaskQueue row per simulated queue.
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
      // Re-seeding overwrites concurrencyLimit, so a surviving override would contradict it.
      update: {
        concurrencyLimit,
        concurrencyLimitBase: null,
        concurrencyLimitOverridePercent: null,
        concurrencyLimitOverriddenAt: null,
        concurrencyLimitOverriddenBy: null,
      },
    });
  }

  const { count: pruned } = await prisma.taskQueue.deleteMany({
    where: {
      runtimeEnvironmentId,
      name: { notIn: boundedIn(scenario.queues.map((q) => q.name)) },
    },
  });
  console.log(
    `Ensured ${scenario.queues.length} task queues in Postgres${pruned > 0 ? `, pruned ${pruned} stale` : ""}.`
  );
}

function printHelp() {
  const lines = Object.entries(scenarios).map(
    ([name, build]) => `  ${name.padEnd(28)}${build(720, 10).description}`
  );
  console.log(`Queue metrics simulator: seeds a synthetic tenant with realistic queue metrics.

Usage: pnpm --filter webapp run db:seed:queue-metrics -- [flags]

Flags:
  --scenario <name>   which scenario to seed (default: mixed)
  --project <name>    project to seed into (default: ${PROJECT_NAME}); use one
                      project per scenario to browse them side by side
  --window <dur>      how much history to backfill, e.g. 30m, 6h, 1d (default: 2h)
  --bucket <sec>      seconds per simulated bucket (default: 10)
  --seed <n>          RNG seed for reproducible data (default: 1)
  --usage             stage fake running counts in Redis so the Running column and
                      the Allocation tab's usage bars have data (cleared when omitted)
  --live              after backfilling, keep appending one bucket per interval
  --reset             clear this environment's metrics before seeding
  --reset-only        clear and exit without seeding
  --help              this text

Scenarios:
${lines.join("\n")}

Example designer setup (one project per scenario):
  pnpm --filter webapp run db:seed:queue-metrics -- --scenario mixed --reset
  pnpm --filter webapp run db:seed:queue-metrics -- --scenario many-queues --project qm-many-queues --reset
  pnpm --filter webapp run db:seed:queue-metrics -- --scenario throttled-backlog --project qm-throttled --reset
  pnpm --filter webapp run db:seed:queue-metrics -- --scenario tenant-hotspot --project qm-tenants --usage --reset`);
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help === "true") {
    printHelp();
    process.exit(0);
  }
  const scenarioName = flags.scenario ?? "mixed";
  const build = scenarios[scenarioName];
  if (!build) {
    console.error(
      `Unknown scenario "${scenarioName}". Options: ${Object.keys(scenarios).join(", ")}`
    );
    process.exit(1);
  }
  const bucketSec = Number(flags.bucket ?? 10);
  if (!Number.isFinite(bucketSec) || bucketSec <= 0) {
    console.error(`--bucket must be a positive number of seconds, got: ${flags.bucket}`);
    process.exit(1);
  }
  const windowSec = parseDuration(flags.window ?? "2h");
  const totalBuckets = Math.floor(windowSec / bucketSec);
  if (!Number.isFinite(totalBuckets) || totalBuckets <= 0) {
    console.error(
      `--window must be longer than --bucket (got ${windowSec}s window, ${bucketSec}s bucket)`
    );
    process.exit(1);
  }
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

  const projectName = flags.project ?? PROJECT_NAME;
  let project = await prisma.project.findFirst({
    where: { name: projectName, organizationId: org.id },
  });
  if (!project) {
    project = await createProject({
      organizationSlug: org.slug,
      name: projectName,
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
  await stageRedisUsage(scenario, ids, seed, flags.usage !== "true");
  const rng = mulberry32(seed);
  const backlog = new Array(scenario.queues.length).fill(0);

  console.log(`Scenario "${scenarioName}": ${scenario.description}`);
  console.log(
    `Backfilling ${totalBuckets} x ${bucketSec}s buckets (${flags.window ?? "2h"}) for ${scenario.queues.length} queues...`
  );

  const nowBucket = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec;
  const startBucket = nowBucket - totalBuckets * bucketSec;
  const counters = newCounterState(scenario.queues.length);
  const rows: QueueMetricsRawV1Input[] = [];
  for (let b = 0; b < totalBuckets; b++) {
    const bucketEpochSec = startBucket + b * bucketSec;
    const eventTime = formatChDateTime(new Date(bucketEpochSec * 1000));
    rows.push(
      ...simulateBucket(
        scenario,
        b,
        bucketSec,
        eventTime,
        bucketEpochSec,
        ids,
        backlog,
        counters,
        rng
      )
    );
  }
  await insertBatched(ch, rows, nonce);
  console.log(`Inserted ${rows.length} raw rows.`);

  // The rollups are AggregatingMergeTrees; a read straight after the insert can't wait for merges.
  const raw = (
    ch.writer as unknown as { client: { command: (a: { query: string }) => Promise<unknown> } }
  ).client;
  await raw.command({ query: `OPTIMIZE TABLE trigger_dev.queue_metrics_v1 FINAL` });
  await raw.command({ query: `OPTIMIZE TABLE trigger_dev.queue_metrics_5m_v1 FINAL` });
  await raw.command({ query: `OPTIMIZE TABLE trigger_dev.env_metrics_v1 FINAL` });
  await raw.command({ query: `OPTIMIZE TABLE trigger_dev.queue_metrics_ck_v1 FINAL` });

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
      const bucketEpochSec = Math.floor(Date.now() / 1000 / bucketSec) * bucketSec;
      const eventTime = formatChDateTime(new Date(bucketEpochSec * 1000));
      const liveRows = simulateBucket(
        scenario,
        b,
        bucketSec,
        eventTime,
        bucketEpochSec,
        ids,
        backlog,
        counters,
        rng
      );
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
