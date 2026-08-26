#!/usr/bin/env tsx

/**
 * Seeds/fabricates fixture data for the dashboard-agent UAT scenarios (S1-S10) in the
 * local dev environment. Companion script for `dashboard-agent-uat-scenarios.md`.
 *
 * TARGET: the seeded "References" org / "hello-world" project (see apps/webapp/seed.ts).
 * Most scenarios use that project's DEVELOPMENT environment. S6 (dirty deploy) needs a
 * real deployment, so it uses the project's PRODUCTION environment instead.
 *
 * Postgres rows are written with the real Prisma client. Redis run-queue state is written
 * by hand, replicating the key format from
 * internal-packages/run-engine/src/run-queue/keyProducer.ts and the `slotHoldersOfQueue`
 * Lua script in internal-packages/run-engine/src/run-queue/index.ts (this package has no
 * public export for the key producer, so the format is reproduced here rather than
 * imported - keep it in sync if keyProducer.ts changes).
 *
 * Each scenario tags everything it creates with a "uat-" prefix (queue names,
 * idempotencyKey, taskIdentifier, externalId) so `clean` can find and remove it, and so
 * re-running a subcommand upserts instead of duplicating.
 *
 * IDEMPOTENCY DEVIATIONS FROM THE UAT DOC (verified against schema/code, not guessed):
 *  - TaskRun has no "QUEUED" status; the 5 queued runs use PENDING (the real
 *    "waiting to be executed" status), with queuedAt set and no startedAt.
 *  - TaskRun has no "finishedAt" field; the doc's "finishedAt" maps to `completedAt`.
 *  - S4 uses `currentDequeued` (not `currentConcurrency`) at the env level - that's the
 *    set `QueueRetrievePresenter`'s envConcurrency actually reads
 *    (RunQueue#currentConcurrencyOfEnvironment -> SCARD(envCurrentDequeuedKey)).
 *  - S10: inserting directly into ClickHouse `task_runs_v2` (source of the `errors_v1`
 *    materialized view) from a script is impractical to get right generically, so this
 *    only writes the Postgres side (ErrorGroupState.resolvedAt) and prints the exact
 *    `clickhouse-client` INSERT to run manually for the ClickHouse side.
 *
 * USAGE:
 *   pnpm exec tsx scripts/seed-dashboard-agent-uat.ts <subcommand>
 *
 * SUBCOMMANDS:
 *   slots         S1  - uat-slots queue (limit 1), 1 EXECUTING holder, 5 PENDING/queued runs
 *   mismatch      S2  - as `slots`, then flips the holder to COMPLETED_SUCCESSFULLY in
 *                        Postgres while leaving its Redis slot membership intact
 *   ck-invisible  S3  - a concurrencyKey queue with a run admitted into the CK variant's
 *                        currentConcurrency set only (not in ckIndex) - structurally unlistable
 *   env-binding   S4  - fills the env's currentDequeued set to limit*burstFactor across
 *                        filler queues, plus a roomy queue (limit 50) with 1 running
 *   wait          S5  - (a) a run with delayUntil in the past, wait measured from queuedAt
 *                        (b) a terminal EXPIRED run with no startedAt
 *   dirty-deploy  S6  - a WorkerDeployment with git.dirty=true, linked to a run
 *   recurred      S10 - an ErrorGroupState resolved 2 days ago (prints manual CH SQL)
 *   all               - runs every scenario above
 *   clean             - removes everything this script created
 *
 * ENV VARS (same as the running webapp - see .env.example):
 *   DATABASE_URL, REDIS_HOST, REDIS_PORT, REDIS_USERNAME, REDIS_PASSWORD, REDIS_TLS_DISABLED
 */

import { randomBytes } from "node:crypto";
import { PrismaClient, boundedIn, type RuntimeEnvironment } from "@trigger.dev/database";
import { createRedisClient, type Redis } from "@internal/redis";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";

const UAT_TAG_PREFIX = "uat-";

const REFERENCES_ORG_TITLE = "References";
const HELLO_WORLD_PROJECT_NAME = "hello-world";

// Same effective prefix RunEngine applies to its RunQueue redis client:
// options.queue.redis.keyPrefix ("engine:") + "runqueue:" (see engine/index.ts).
const RUN_QUEUE_REDIS_KEY_PREFIX = "engine:runqueue:";

type SummaryRow = { scenario: string; kind: string; id: string; detail?: string };
const summary: SummaryRow[] = [];
function record(scenario: string, kind: string, id: string, detail?: string) {
  summary.push({ scenario, kind, id, detail });
}

// ---------------------------------------------------------------------------
// Redis key helpers - mirror RunQueueFullKeyProducer's logical key format.
// ---------------------------------------------------------------------------

function orgSection(orgId: string) {
  return `{org:${orgId}}`;
}
function envKeyBase(orgId: string, projectId: string, envId: string) {
  return `${orgSection(orgId)}:proj:${projectId}:env:${envId}`;
}
function queueKey(
  orgId: string,
  projectId: string,
  envId: string,
  queueName: string,
  concurrencyKey?: string
) {
  const base = `${envKeyBase(orgId, projectId, envId)}:queue:${queueName}`;
  return concurrencyKey ? `${base}:ck:${concurrencyKey}` : base;
}
const currentConcurrencyKey = (baseKey: string) => `${baseKey}:currentConcurrency`;
const currentDequeuedKey = (baseKey: string) => `${baseKey}:currentDequeued`;
const ckIndexKey = (baseQueueKey: string) => `${baseQueueKey}:ckIndex`;
const envCurrentConcurrencyKey = (orgId: string, projectId: string, envId: string) =>
  `${currentConcurrencyKey(envKeyBase(orgId, projectId, envId))}`;
const envCurrentDequeuedKey = (orgId: string, projectId: string, envId: string) =>
  `${currentDequeuedKey(envKeyBase(orgId, projectId, envId))}`;

function randomHex(bytes: number) {
  return randomBytes(bytes).toString("hex");
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

type Ctx = {
  prisma: PrismaClient;
  redis: Redis;
  orgId: string;
  projectId: string;
  devEnv: RuntimeEnvironment;
  prodEnv: RuntimeEnvironment;
};

async function resolveTarget(prisma: PrismaClient, redis: Redis): Promise<Ctx> {
  // Resolved via the project, not a specific member's org membership - a self-hosted dev
  // instance can have more than one "References" org (re-seeded under different users), and
  // whoever actually holds the hello-world project is the one that matters here.
  const project = await prisma.project.findFirst({
    where: { name: HELLO_WORLD_PROJECT_NAME, organization: { title: REFERENCES_ORG_TITLE } },
    include: { organization: true },
  });
  if (!project) {
    throw new Error(
      `Project "${HELLO_WORLD_PROJECT_NAME}" not found under a "${REFERENCES_ORG_TITLE}" org. Run "pnpm run db:seed" first.`
    );
  }
  const organization = project.organization;

  // A project can have more than one DEVELOPMENT env (one per member) - pick the
  // earliest-created for determinism, independent of which user last seeded/used it.
  const environments = await prisma.runtimeEnvironment.findMany({
    where: { projectId: project.id },
    orderBy: { createdAt: "asc" },
  });
  const devEnv = environments.find((e) => e.type === "DEVELOPMENT");
  const prodEnv = environments.find((e) => e.type === "PRODUCTION");
  if (!devEnv || !prodEnv) {
    throw new Error(`Missing dev/prod environment for project ${project.name}.`);
  }

  return { prisma, redis, orgId: organization.id, projectId: project.id, devEnv, prodEnv };
}

// ---------------------------------------------------------------------------
// Postgres upsert helpers
// ---------------------------------------------------------------------------

async function upsertQueue(
  ctx: Ctx,
  env: RuntimeEnvironment,
  name: string,
  concurrencyLimit: number | null
) {
  return ctx.prisma.taskQueue.upsert({
    where: { runtimeEnvironmentId_name: { runtimeEnvironmentId: env.id, name } },
    create: {
      friendlyId: generateFriendlyId("queue"),
      name,
      type: "NAMED",
      projectId: ctx.projectId,
      runtimeEnvironmentId: env.id,
      concurrencyLimit,
    },
    update: { concurrencyLimit },
  });
}

type RunFields = {
  idempotencyKey: string;
  env: RuntimeEnvironment;
  queue: string;
  status: "PENDING" | "EXECUTING" | "COMPLETED_SUCCESSFULLY" | "EXPIRED" | "DELAYED";
  concurrencyKey?: string;
  delayUntil?: Date;
  queuedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  expiredAt?: Date;
  createdAt?: Date;
  lockedToVersionId?: string;
  taskIdentifier?: string;
};

async function upsertRun(ctx: Ctx, fields: RunFields) {
  const taskIdentifier = fields.taskIdentifier ?? "uat-fixture-task";
  const where = {
    runtimeEnvironmentId_taskIdentifier_idempotencyKey: {
      runtimeEnvironmentId: fields.env.id,
      taskIdentifier,
      idempotencyKey: fields.idempotencyKey,
    },
  };

  const shared = {
    status: fields.status,
    queue: fields.queue,
    concurrencyKey: fields.concurrencyKey,
    delayUntil: fields.delayUntil,
    queuedAt: fields.queuedAt,
    startedAt: fields.startedAt,
    completedAt: fields.completedAt,
    expiredAt: fields.expiredAt,
    lockedToVersionId: fields.lockedToVersionId,
  };

  const existing = await ctx.prisma.taskRun.findFirst({
    where: where.runtimeEnvironmentId_taskIdentifier_idempotencyKey,
  });
  if (existing) {
    return ctx.prisma.taskRun.update({ where, data: shared });
  }

  return ctx.prisma.taskRun.create({
    data: {
      friendlyId: generateFriendlyId("run"),
      engine: "V2",
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      traceId: randomHex(16),
      spanId: randomHex(8),
      runtimeEnvironmentId: fields.env.id,
      environmentType: fields.env.type,
      projectId: ctx.projectId,
      organizationId: ctx.orgId,
      idempotencyKey: fields.idempotencyKey,
      createdAt: fields.createdAt,
      ...shared,
    },
  });
}

// ---------------------------------------------------------------------------
// S1: slots
// ---------------------------------------------------------------------------

async function seedSlots(ctx: Ctx) {
  const queueName = "uat-slots";
  const queue = await upsertQueue(ctx, ctx.devEnv, queueName, 1);
  record("S1", "queue", queue.friendlyId, `${queueName} (limit 1)`);

  const now = Date.now();
  const holder = await upsertRun(ctx, {
    idempotencyKey: "uat-slots-holder",
    env: ctx.devEnv,
    queue: queueName,
    status: "EXECUTING",
    queuedAt: new Date(now - 30_000),
    startedAt: new Date(now - 25_000),
  });
  record("S1", "run (holder)", holder.friendlyId, "EXECUTING");

  const base = queueKey(ctx.orgId, ctx.projectId, ctx.devEnv.id, queueName);
  await ctx.redis.sadd(currentConcurrencyKey(base), holder.id);
  await ctx.redis.sadd(currentDequeuedKey(base), holder.id);

  for (let i = 0; i < 5; i++) {
    const queuedAt = new Date(now - (5 - i) * 5_000);
    const queued = await upsertRun(ctx, {
      idempotencyKey: `uat-slots-queued-${i}`,
      env: ctx.devEnv,
      queue: queueName,
      status: "PENDING",
      queuedAt,
    });
    record("S1", "run (queued)", queued.friendlyId, `#${i}`);
    await ctx.redis.zadd(base, queuedAt.getTime(), queued.id);
  }
}

// ---------------------------------------------------------------------------
// S2: mismatch
// ---------------------------------------------------------------------------

async function seedMismatch(ctx: Ctx) {
  await seedSlots(ctx);

  const holder = await ctx.prisma.taskRun.findFirst({
    where: {
      runtimeEnvironmentId: ctx.devEnv.id,
      taskIdentifier: "uat-fixture-task",
      idempotencyKey: "uat-slots-holder",
    },
  });
  if (!holder) throw new Error("uat-slots-holder run not found after seedSlots");

  // Flip Postgres only - Redis membership (currentConcurrency/currentDequeued) is left
  // untouched on purpose, fabricating the holder-vs-facts mismatch.
  const updated = await ctx.prisma.taskRun.update({
    where: { id: holder.id },
    data: { status: "COMPLETED_SUCCESSFULLY", completedAt: new Date() },
  });
  record(
    "S2",
    "run (mismatched holder)",
    updated.friendlyId,
    "PG COMPLETED, Redis still holds slot"
  );
}

// ---------------------------------------------------------------------------
// S3: ck-invisible
// ---------------------------------------------------------------------------

async function seedCkInvisible(ctx: Ctx) {
  const queueName = "uat-ck-queue";
  const concurrencyKeyValue = "uat-ck-fastpath";
  const queue = await upsertQueue(ctx, ctx.devEnv, queueName, 3);
  record("S3", "queue", queue.friendlyId, `${queueName} (concurrencyKey, limit 3)`);

  const run = await upsertRun(ctx, {
    idempotencyKey: "uat-ck-admitted",
    env: ctx.devEnv,
    queue: queueName,
    status: "PENDING",
    concurrencyKey: concurrencyKeyValue,
    queuedAt: new Date(),
  });
  record("S3", "run (invisible admitted holder)", run.friendlyId, `ck=${concurrencyKeyValue}`);

  // Admitted fast-path: SADD into the CK variant's own currentConcurrency set only.
  // Deliberately NOT added to ckIndex (a ZSET the slotHoldersOfQueue Lua script walks to
  // find CK variants) and runningCounter is left untouched (GET defaults to 0) - so this
  // holder is structurally unlistable, matching the "admitted holders may not be visible"
  // observability limit.
  const ckQueueKey = queueKey(
    ctx.orgId,
    ctx.projectId,
    ctx.devEnv.id,
    queueName,
    concurrencyKeyValue
  );
  await ctx.redis.sadd(currentConcurrencyKey(ckQueueKey), run.id);
}

// ---------------------------------------------------------------------------
// S4: env-binding
// ---------------------------------------------------------------------------

// Cap on real (Postgres-backed) filler holders. A live env's maximumConcurrencyLimit can be
// large (e.g. an org bumped to 300), and target = limit * burstFactor shouldn't turn into
// hundreds of TaskRun rows just to make a number line up. Past this cap, filler holders are
// synthetic Redis-only ids (tracked in envBindingSyntheticIdsKey so `clean` can remove them).
const ENV_BINDING_MAX_REAL_FILLER_RUNS = 10;

function envBindingSyntheticIdsKey(orgId: string, projectId: string, envId: string) {
  return `uat:env-binding-synthetic:${envKeyBase(orgId, projectId, envId)}`;
}

async function seedEnvBinding(ctx: Ctx) {
  const burstFactor =
    typeof ctx.devEnv.concurrencyLimitBurstFactor === "number"
      ? ctx.devEnv.concurrencyLimitBurstFactor
      : ctx.devEnv.concurrencyLimitBurstFactor.toNumber();
  const target = Math.max(1, Math.ceil(ctx.devEnv.maximumConcurrencyLimit * burstFactor));

  const roomyQueue = await upsertQueue(ctx, ctx.devEnv, "uat-slots-roomy", 50);
  record("S4", "queue", roomyQueue.friendlyId, "uat-slots-roomy (limit 50)");

  const fillerQueueNames = ["uat-env-filler-1", "uat-env-filler-2"];
  for (const name of fillerQueueNames) {
    const q = await upsertQueue(ctx, ctx.devEnv, name, target + 10);
    record("S4", "queue", q.friendlyId, `${name} (limit ${target + 10})`);
  }

  const now = new Date();

  // 1 run in the roomy queue, the rest spread across the filler queues - together they
  // saturate the env (current == limit * burstFactor) while uat-slots-roomy itself has
  // plenty of spare capacity.
  const roomyRun = await upsertRun(ctx, {
    idempotencyKey: "uat-env-roomy-holder",
    env: ctx.devEnv,
    queue: "uat-slots-roomy",
    status: "EXECUTING",
    queuedAt: now,
    startedAt: now,
  });
  record("S4", "run", roomyRun.friendlyId, "uat-slots-roomy holder");
  await addRunningHolder(ctx, "uat-slots-roomy", roomyRun.id);

  const fillerCount = target - 1;
  const realFillerCount = Math.min(fillerCount, ENV_BINDING_MAX_REAL_FILLER_RUNS);
  const syntheticIdsKey = envBindingSyntheticIdsKey(ctx.orgId, ctx.projectId, ctx.devEnv.id);
  await ctx.redis.del(syntheticIdsKey);

  for (let i = 0; i < fillerCount; i++) {
    const queueName = fillerQueueNames[i % fillerQueueNames.length];
    if (i < realFillerCount) {
      const run = await upsertRun(ctx, {
        idempotencyKey: `uat-env-filler-run-${i}`,
        env: ctx.devEnv,
        queue: queueName,
        status: "EXECUTING",
        queuedAt: now,
        startedAt: now,
      });
      record("S4", "run", run.friendlyId, `${queueName} holder #${i}`);
      await addRunningHolder(ctx, queueName, run.id);
    } else {
      // Synthetic: no TaskRun row, just Redis membership padding the env count to target.
      const syntheticId = `uat-env-filler-synthetic-${i}`;
      await ctx.redis.sadd(syntheticIdsKey, syntheticId);
      await addRunningHolder(ctx, queueName, syntheticId);
    }
  }

  record(
    "S4",
    "env saturation",
    ctx.devEnv.id,
    `current=${target} target=limit(${ctx.devEnv.maximumConcurrencyLimit}) * burstFactor(${burstFactor})=${target}` +
      (fillerCount > realFillerCount
        ? ` (${realFillerCount} real runs + ${fillerCount - realFillerCount} synthetic Redis-only holders)`
        : "")
  );

  async function addRunningHolder(c: Ctx, queueName: string, runId: string) {
    const base = queueKey(c.orgId, c.projectId, c.devEnv.id, queueName);
    await c.redis.sadd(currentConcurrencyKey(base), runId);
    await c.redis.sadd(currentDequeuedKey(base), runId);
    await c.redis.sadd(envCurrentDequeuedKey(c.orgId, c.projectId, c.devEnv.id), runId);
  }
}

// ---------------------------------------------------------------------------
// S5: wait
// ---------------------------------------------------------------------------

async function seedWait(ctx: Ctx) {
  const queueName = "uat-wait-queue";
  const queue = await upsertQueue(ctx, ctx.devEnv, queueName, 5);
  record("S5", "queue", queue.friendlyId, queueName);

  const now = Date.now();

  // (a) delayed run: delay elapses, then it's queued and starts shortly after. Wait time
  // should be measured from queuedAt, not from createdAt (which would wrongly include the delay).
  const delayUntil = new Date(now - 40 * 60_000);
  const queuedAt = new Date(delayUntil.getTime());
  const startedAt = new Date(queuedAt.getTime() + 5_000);
  const completedAt = new Date(startedAt.getTime() + 60_000);
  const delayedRun = await upsertRun(ctx, {
    idempotencyKey: "uat-wait-delayed",
    env: ctx.devEnv,
    queue: queueName,
    status: "COMPLETED_SUCCESSFULLY",
    delayUntil,
    queuedAt,
    startedAt,
    completedAt,
    createdAt: new Date(delayUntil.getTime() - 60_000),
  });
  record(
    "S5a",
    "run (delayed then ran)",
    delayedRun.friendlyId,
    "delay 40m, wait counted from queuedAt"
  );

  // (b) terminal EXPIRED run: queuedAt set, never started, finished (expired) a day ago.
  const createdAt = new Date(now - 10 * 24 * 60 * 60_000);
  const expiredQueuedAt = new Date(createdAt.getTime() + 60_000);
  const expiredAt = new Date(now - 24 * 60 * 60_000);
  const expiredRun = await upsertRun(ctx, {
    idempotencyKey: "uat-wait-expired",
    env: ctx.devEnv,
    queue: queueName,
    status: "EXPIRED",
    queuedAt: expiredQueuedAt,
    completedAt: expiredAt,
    expiredAt,
    createdAt,
  });
  record("S5b", "run (terminal EXPIRED)", expiredRun.friendlyId, "no startedAt, finished 24h ago");
}

// ---------------------------------------------------------------------------
// S6: dirty-deploy
// ---------------------------------------------------------------------------

async function seedDirtyDeploy(ctx: Ctx) {
  const version = "uat-dirty-1";

  const worker = await ctx.prisma.backgroundWorker.upsert({
    where: {
      projectId_runtimeEnvironmentId_version: {
        projectId: ctx.projectId,
        runtimeEnvironmentId: ctx.prodEnv.id,
        version,
      },
    },
    create: {
      friendlyId: generateFriendlyId("worker"),
      contentHash: "uat-dirty-deploy-hash",
      sdkVersion: "0.0.0-uat",
      cliVersion: "0.0.0-uat",
      projectId: ctx.projectId,
      runtimeEnvironmentId: ctx.prodEnv.id,
      version,
      metadata: {},
    },
    update: {},
  });
  record("S6", "worker", worker.friendlyId, version);

  const deployment = await ctx.prisma.workerDeployment.upsert({
    where: { environmentId_version: { environmentId: ctx.prodEnv.id, version } },
    create: {
      friendlyId: generateFriendlyId("deployment"),
      contentHash: "uat-dirty-deploy-hash",
      shortCode: "uatdirty",
      version,
      projectId: ctx.projectId,
      environmentId: ctx.prodEnv.id,
      workerId: worker.id,
      commitSHA: "abc123uatdirty",
      externalId: "uat-dirty-deploy",
      status: "DEPLOYED",
      deployedAt: new Date(),
      // GitMeta shape (packages/core/src/v3/schemas/common.ts) - `dirty` is what
      // resolveRunCommit (apps/webapp/app/services/dashboardAgent.server.ts) reads.
      git: {
        source: "local",
        commitSha: "abc123uatdirty",
        commitMessage: "uat dirty deploy fixture",
        commitAuthorName: "UAT Seed",
        commitRef: "main",
        dirty: true,
      },
    },
    update: {
      commitSHA: "abc123uatdirty",
      git: {
        source: "local",
        commitSha: "abc123uatdirty",
        commitMessage: "uat dirty deploy fixture",
        commitAuthorName: "UAT Seed",
        commitRef: "main",
        dirty: true,
      },
    },
  });
  record("S6", "deployment", deployment.friendlyId, "git.dirty=true");

  const queueName = "uat-dirty-deploy-queue";
  const queue = await upsertQueue(ctx, ctx.prodEnv, queueName, 5);
  record("S6", "queue", queue.friendlyId, queueName);

  const run = await upsertRun(ctx, {
    idempotencyKey: "uat-dirty-deploy-run",
    env: ctx.prodEnv,
    queue: queueName,
    status: "COMPLETED_SUCCESSFULLY",
    queuedAt: new Date(),
    startedAt: new Date(),
    completedAt: new Date(),
    lockedToVersionId: worker.id,
  });
  record("S6", "run", run.friendlyId, "locked to dirty deployment");
}

// ---------------------------------------------------------------------------
// S10: recurred
// ---------------------------------------------------------------------------

async function seedRecurred(ctx: Ctx) {
  const taskIdentifier = "uat-recurred-task";
  const errorFingerprint = "uat-recurred-fp";
  const resolvedAt = new Date(Date.now() - 2 * 24 * 60 * 60_000);
  const lastSeen = new Date(Date.now() - 60 * 60_000);

  const user = await ctx.prisma.user.findFirst({ where: { email: "local@trigger.dev" } });

  const errorGroup = await ctx.prisma.errorGroupState.upsert({
    where: {
      environmentId_taskIdentifier_errorFingerprint: {
        environmentId: ctx.devEnv.id,
        taskIdentifier,
        errorFingerprint,
      },
    },
    create: {
      organizationId: ctx.orgId,
      projectId: ctx.projectId,
      environmentId: ctx.devEnv.id,
      taskIdentifier,
      errorFingerprint,
      status: "RESOLVED",
      resolvedAt,
      resolvedInVersion: "uat",
      resolvedBy: user?.id,
    },
    update: { status: "RESOLVED", resolvedAt, resolvedInVersion: "uat", resolvedBy: user?.id },
  });
  record("S10", "ErrorGroupState", errorGroup.id, `resolvedAt=${resolvedAt.toISOString()}`);

  const version = Date.now();
  const errorJson = JSON.stringify({
    data: {
      type: "Error",
      message: "uat recurred fixture error",
      stack: "Error: uat recurred fixture error\n    at uatFixture (uat.ts:1:1)",
    },
  }).replace(/'/g, "''");

  console.log("\nS10: Postgres side done. ClickHouse errors_v1 is a materialized view over");
  console.log("task_runs_v2 - run this manually to make the error 'recur' after resolvedAt:\n");
  console.log(
    `clickhouse-client --query "INSERT INTO trigger_dev.task_runs_v2 ` +
      `(environment_id, organization_id, project_id, run_id, friendly_id, environment_type, ` +
      `engine, status, task_identifier, queue, task_version, error, created_at, updated_at, _version) ` +
      `VALUES ('${ctx.devEnv.id}', '${ctx.orgId}', '${ctx.projectId}', 'uat-recurred-run', ` +
      `'run_uatrecurred', 'DEVELOPMENT', 'V2', 'COMPLETED_WITH_ERRORS', '${taskIdentifier}', ` +
      `'uat-recurred-task', 'uat', '${errorJson}', '${formatChDateTime(lastSeen)}', ` +
      `'${formatChDateTime(lastSeen)}', ${version})"\n`
  );
}

function formatChDateTime(date: Date) {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

// ---------------------------------------------------------------------------
// clean
// ---------------------------------------------------------------------------

async function clean(ctx: Ctx) {
  const runs = await ctx.prisma.taskRun.findMany({
    where: {
      runtimeEnvironmentId: { in: [ctx.devEnv.id, ctx.prodEnv.id] },
      idempotencyKey: { startsWith: UAT_TAG_PREFIX },
    },
    select: { id: true },
  });
  const runIds = runs.map((r) => r.id);

  const queueNames = [
    "uat-slots",
    "uat-slots-roomy",
    "uat-ck-queue",
    "uat-env-filler-1",
    "uat-env-filler-2",
    "uat-wait-queue",
    "uat-dirty-deploy-queue",
  ];
  for (const env of [ctx.devEnv, ctx.prodEnv]) {
    for (const name of queueNames) {
      const base = queueKey(ctx.orgId, ctx.projectId, env.id, name);
      const ckBase = queueKey(ctx.orgId, ctx.projectId, env.id, name, "uat-ck-fastpath");
      await ctx.redis.del(
        base,
        currentConcurrencyKey(base),
        currentDequeuedKey(base),
        ckIndexKey(base),
        `${base}:runningCounter`,
        currentConcurrencyKey(ckBase),
        currentDequeuedKey(ckBase)
      );
    }
    if (runIds.length > 0) {
      await ctx.redis.srem(envCurrentDequeuedKey(ctx.orgId, ctx.projectId, env.id), ...runIds);
      await ctx.redis.srem(envCurrentConcurrencyKey(ctx.orgId, ctx.projectId, env.id), ...runIds);
    }

    const syntheticIdsKey = envBindingSyntheticIdsKey(ctx.orgId, ctx.projectId, env.id);
    const syntheticIds = await ctx.redis.smembers(syntheticIdsKey);
    if (syntheticIds.length > 0) {
      await ctx.redis.srem(
        envCurrentDequeuedKey(ctx.orgId, ctx.projectId, env.id),
        ...syntheticIds
      );
    }
    await ctx.redis.del(syntheticIdsKey);
  }

  if (runIds.length > 0) {
    await ctx.prisma.taskRunExecutionSnapshot.deleteMany({
      where: { runId: { in: boundedIn(runIds) } },
    });
    await ctx.prisma.taskRun.deleteMany({ where: { id: { in: boundedIn(runIds) } } });
  }

  await ctx.prisma.taskQueue.deleteMany({
    where: {
      runtimeEnvironmentId: { in: [ctx.devEnv.id, ctx.prodEnv.id] },
      name: { startsWith: UAT_TAG_PREFIX },
    },
  });

  // BackgroundWorker -> WorkerDeployment is onDelete: Cascade.
  await ctx.prisma.backgroundWorker.deleteMany({
    where: { runtimeEnvironmentId: ctx.prodEnv.id, version: "uat-dirty-1" },
  });

  await ctx.prisma.errorGroupState.deleteMany({
    where: { environmentId: ctx.devEnv.id, taskIdentifier: "uat-recurred-task" },
  });

  console.log(`Cleaned ${runIds.length} runs, uat-* queues, dirty-deploy worker, error group.`);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const SUBCOMMANDS = [
  "slots",
  "mismatch",
  "ck-invisible",
  "env-binding",
  "wait",
  "dirty-deploy",
  "recurred",
  "all",
  "clean",
] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

function printHelp() {
  console.log(`Usage: pnpm exec tsx scripts/seed-dashboard-agent-uat.ts <subcommand>

Subcommands:
  slots         S1  uat-slots queue (limit 1): 1 EXECUTING holder + 5 queued runs
  mismatch      S2  holder flipped to COMPLETED_SUCCESSFULLY in PG, Redis slot untouched
  ck-invisible  S3  concurrencyKey run admitted but structurally unlistable
  env-binding   S4  env saturated via currentDequeued, one roomy queue with headroom
  wait          S5  (a) delay-then-run, (b) terminal EXPIRED with no startedAt
  dirty-deploy  S6  WorkerDeployment with git.dirty=true, linked to a run
  recurred      S10 ErrorGroupState resolved 2d ago (prints manual ClickHouse SQL)
  all               run every scenario above
  clean             remove everything this script created

Env: DATABASE_URL, REDIS_HOST, REDIS_PORT, REDIS_USERNAME, REDIS_PASSWORD, REDIS_TLS_DISABLED
`);
}

function printSummary() {
  if (summary.length === 0) return;
  console.log("\nSummary:");
  const widths = {
    scenario: Math.max(8, ...summary.map((r) => r.scenario.length)),
    kind: Math.max(4, ...summary.map((r) => r.kind.length)),
    id: Math.max(2, ...summary.map((r) => r.id.length)),
  };
  for (const row of summary) {
    console.log(
      `  ${row.scenario.padEnd(widths.scenario)}  ${row.kind.padEnd(widths.kind)}  ${row.id.padEnd(
        widths.id
      )}  ${row.detail ?? ""}`
    );
  }
}

async function main() {
  const arg = process.argv[2];

  if (!arg || arg === "--help" || arg === "-h") {
    printHelp();
    process.exit(arg ? 0 : 1);
  }

  if (!(SUBCOMMANDS as readonly string[]).includes(arg)) {
    console.error(`Unknown subcommand: ${arg}\n`);
    printHelp();
    process.exit(1);
  }

  const subcommand = arg as Subcommand;

  const prisma = new PrismaClient();
  const redis = createRedisClient({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    keyPrefix: RUN_QUEUE_REDIS_KEY_PREFIX,
    ...(process.env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });

  try {
    const ctx = await resolveTarget(prisma, redis);

    switch (subcommand) {
      case "slots":
        await seedSlots(ctx);
        break;
      case "mismatch":
        await seedMismatch(ctx);
        break;
      case "ck-invisible":
        await seedCkInvisible(ctx);
        break;
      case "env-binding":
        await seedEnvBinding(ctx);
        break;
      case "wait":
        await seedWait(ctx);
        break;
      case "dirty-deploy":
        await seedDirtyDeploy(ctx);
        break;
      case "recurred":
        await seedRecurred(ctx);
        break;
      case "all":
        await seedSlots(ctx);
        await seedMismatch(ctx);
        await seedCkInvisible(ctx);
        await seedEnvBinding(ctx);
        await seedWait(ctx);
        await seedDirtyDeploy(ctx);
        await seedRecurred(ctx);
        break;
      case "clean":
        await clean(ctx);
        break;
    }

    printSummary();
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
