/**
 * The Watch / Investigate scenario kit: one command per thing a watch can see
 * happen, so proving a flow locally is a verb rather than hand-run Redis and
 * ClickHouse surgery.
 *
 *   pnpm --filter webapp run scenarios:watch -- queue:fill email-sends 400
 *   pnpm --filter webapp run scenarios:watch -- queue:drain email-sends
 *   pnpm --filter webapp run scenarios:watch -- error:recur
 *   pnpm --filter webapp run scenarios:watch -- run:fail 90
 *   pnpm --filter webapp run scenarios:watch -- health:recover
 *   pnpm --filter webapp run scenarios:watch -- --help
 *
 * It runs on top of the seeded `agent-examples` stand (`db:seed:agent-examples`)
 * and only ever moves the things a watch reads:
 *
 * - the run-queue depth in Redis, both keys, through the seeder's own staging
 *   (`seed-agent-examples-redis.mts`) — a watch checks the PER-QUEUE key, the
 *   report prefers the env-level one, so both have to agree;
 * - one fresh occurrence of the seeded 429 error group in ClickHouse;
 * - a real run in the separate `hello-world` references project, triggered
 *   through the public API, for the run-finished / run-failed watches;
 * - the health report's live window, by delegating to the seeder's own
 *   `--degrade` / `--recover`.
 *
 * Nothing here wipes the stand, and every verb is idempotent — re-running one
 * leaves the same state, not more of it. Each verb prints what to do in the
 * dashboard next.
 *
 * Walkthroughs, dashboard clicks and expected wording:
 * `internal-packages/dashboard-agent/SCENARIOS.md`.
 */
import { ClickHouse } from "@internal/clickhouse";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
// oxlint-disable import/default -- deliberate CommonJS interop, as in the seeder:
// this entry is ESM, tsx compiles the app's `.ts` to CommonJS, and an ESM importer
// reaches a CommonJS module's exports only through `default`.
import dbServer from "./app/db.server";
import {
  openRedis,
  queueDepthKey,
  envQueueKey,
  stageRedisDepth,
} from "./seed-agent-examples-redis.mjs";

const { prisma } = dbServer;

/** The seeded stand. Must match `seed-agent-examples.mts`. */
const STAND_PROJECT_REF = "proj_agentexamplesseed01";
/** The references repo's `hello-world` project, created by `pnpm run db:seed`. */
const HELLO_WORLD_PROJECT_REF = "proj_rrkpdguyagvsoktglnod";
/** The two tasks the run watches need. The guidebook carries their source. */
const SLOW_FAIL_TASK_ID = "slow-fail";
const SLOW_SUCCEED_TASK_ID = "slow-succeed";
/** Default sleep for those tasks, long enough to arm a watch while the run is up. */
const DEFAULT_RUN_SECONDS = 60;

const APP_ORIGIN = process.env.APP_ORIGIN ?? "http://localhost:3030";

// ---------------------------------------------------------------------------
// Prerequisites, each with an error that says what to run
// ---------------------------------------------------------------------------

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

type StandEnv = { id: string; slug: string; apiKey: string };
type Stand = {
  organizationId: string;
  projectId: string;
  projectSlug: string;
  environment: StandEnv;
};

/**
 * The stand, for one environment. Prod by default: it's the environment the
 * seeded transcripts cite and the one the showcase watches are armed on.
 */
async function resolveStand(envFlag: string | undefined): Promise<Stand> {
  const type = (envFlag ?? "prod") === "dev" ? "DEVELOPMENT" : "PRODUCTION";
  const project = await prisma.project.findFirst({ where: { externalRef: STAND_PROJECT_REF } });
  if (!project) {
    fail(
      `No "agent-examples" project. Seed the stand first:\n` +
        `  pnpm --filter webapp run db:seed:agent-examples`
    );
  }
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: { projectId: project.id, type },
  });
  if (!environment) {
    fail(`The stand has no ${type} environment. Re-run db:seed:agent-examples.`);
  }
  return {
    organizationId: project.organizationId,
    projectId: project.id,
    projectSlug: project.slug,
    environment: { id: environment.id, slug: environment.slug, apiKey: environment.apiKey },
  };
}

async function requireQueue(stand: Stand, name: string) {
  const queue = await prisma.taskQueue.findFirst({
    where: { runtimeEnvironmentId: stand.environment.id, name },
    select: { name: true },
  });
  if (queue) return;
  const queues = await prisma.taskQueue.findMany({
    where: { runtimeEnvironmentId: stand.environment.id },
    select: { name: true },
  });
  fail(
    `No queue "${name}" in ${stand.environment.slug}. The stand has: ` +
      `${queues.map((row: { name: string }) => row.name).join(", ") || "(none — re-seed)"}`
  );
}

function clickhouse(): ClickHouse {
  const url = process.env.CLICKHOUSE_URL ?? process.env.EVENTS_CLICKHOUSE_URL;
  if (!url) {
    fail("CLICKHOUSE_URL not set. Is `pnpm run docker` up and apps/webapp/.env in place?");
  }
  const parsed = new URL(url);
  // Never echo the URL — it carries credentials.
  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  if (!localHosts.has(parsed.hostname)) {
    fail(`Refusing to run against a non-local ClickHouse host: ${parsed.hostname}`);
  }
  parsed.searchParams.delete("secure");
  return new ClickHouse({ url: parsed.toString(), name: "watch-scenarios" });
}

type RawCommand = {
  command: (a: { query: string }) => Promise<unknown>;
  query: (a: { query: string; format: string }) => Promise<{ json: () => Promise<unknown> }>;
};

function rawClient(ch: ClickHouse): RawCommand {
  return (ch.writer as unknown as { client: RawCommand }).client;
}

// ---------------------------------------------------------------------------
// Queue depth: fill / grow / drain
// ---------------------------------------------------------------------------

/** Reads both keys back, so the printed number is the one a watch will see. */
async function reportDepths(stand: Stand, queueName: string) {
  const redis = await openRedis();
  if (!redis) {
    fail(
      "Redis is not local, so nothing was staged. Point RUN_ENGINE_RUN_QUEUE_REDIS_HOST at localhost."
    );
  }
  try {
    const perQueue = await redis.zcard(
      queueDepthKey(stand.organizationId, stand.projectId, stand.environment.id, queueName)
    );
    const env = await redis.zcard(envQueueKey(stand.organizationId, stand.environment.id));
    await redis.quit();
    return { perQueue, env };
  } catch (error) {
    fail(
      `Redis is unreachable (${error instanceof Error ? error.message : error}). ` +
        `Is \`pnpm run docker\` up?`
    );
  }
}

async function queueFill(stand: Stand, queueName: string, depth: number, ageMinutes: number) {
  await requireQueue(stand, queueName);
  // The seeder's staging, with the cap lifted: a threshold watch reads the exact
  // member count, so the per-queue key has to carry all of it.
  await stageRedisDepth(
    stand.organizationId,
    stand.environment.id,
    depth,
    stand.environment.slug,
    stand.projectId,
    queueName,
    { queueMemberCap: depth, ageMinutes }
  );
  const seen = await reportDepths(stand, queueName);
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

async function queueDrain(stand: Stand, queueName: string) {
  await requireQueue(stand, queueName);
  await stageRedisDepth(
    stand.organizationId,
    stand.environment.id,
    0,
    stand.environment.slug,
    stand.projectId,
    queueName,
    { queueMemberCap: 0 }
  );
  const seen = await reportDepths(stand, queueName);
  if (seen.perQueue !== 0) {
    fail(`${queueName} still reads ${seen.perQueue}. Redis did not take the write.`);
  }
  console.log(`
${queueName} is empty.

An armed "when it drains" watch resolves on its next check (≤5 min) with
"${queueName} queue drained". Arm the watch BEFORE draining — a drain watch
created against an already-empty queue one-shots with "That already happened".`);
}

// ---------------------------------------------------------------------------
// Error recurrence
// ---------------------------------------------------------------------------

type ErrorGroupRow = {
  task_identifier: string;
  error_fingerprint: string;
  task_version: string;
  error_type: string;
  error_message: string;
};

/**
 * A fresh occurrence of the stand's seeded 429 group, in both tables the error
 * pages and the recurrence watch read:
 *
 * - `error_occurrences_v1` gets a new minute row (SummingMergeTree, so a repeat
 *   in the same minute sums rather than duplicating — that's the idempotence);
 * - `errors_v1` is re-inserted from its own row with `last_seen` moved to now.
 *   Its aggregate-state columns are carried over verbatim, which an
 *   AggregatingMergeTree merges back into one group rather than a second one.
 *
 * `error_recurrence` stamps its `since` when the watch is persisted, so this has
 * to run AFTER the watch exists — an occurrence written first is invisible to it.
 */
async function errorRecur(stand: Stand) {
  const ch = clickhouse();
  const raw = rawClient(ch);
  const env = stand.environment.id;

  const found = await raw.query({
    query: `SELECT task_identifier, error_fingerprint, any(task_version) AS task_version,
                   any(error_type) AS error_type, any(error_message) AS error_message
            FROM trigger_dev.error_occurrences_v1
            WHERE environment_id = '${env}'
            GROUP BY task_identifier, error_fingerprint
            ORDER BY max(minute) DESC
            LIMIT 1`,
    format: "JSONEachRow",
  });
  const rows = (await found.json()) as ErrorGroupRow[];
  const group = rows[0];
  if (!group) {
    await ch.close();
    fail(
      `No error group in ${stand.environment.slug}. Seed the stand first:\n` +
        `  pnpm --filter webapp run db:seed:agent-examples`
    );
  }

  await raw.command({
    query: `INSERT INTO trigger_dev.error_occurrences_v1
            SELECT organization_id, project_id, environment_id, task_identifier, error_fingerprint,
                   task_version, toStartOfMinute(now()) AS minute,
                   error_type, error_message, stack_trace, toUInt64(1) AS count
            FROM trigger_dev.error_occurrences_v1
            WHERE environment_id = '${env}' AND error_fingerprint = '${group.error_fingerprint}'
            ORDER BY minute DESC
            LIMIT 1`,
  });

  // FINAL, so the row selected is the merged group rather than one partial part
  // of it — an unmerged part would carry a fraction of the counts forward.
  await raw.command({
    query: `INSERT INTO trigger_dev.errors_v1
            SELECT organization_id, project_id, environment_id, task_identifier, error_fingerprint,
                   error_type, error_message, sample_stack_trace,
                   toDateTime(now()) AS last_seen_date,
                   first_seen,
                   now64(3) AS last_seen,
                   occurrence_count, affected_task_versions,
                   sample_run_id, sample_friendly_id, status_distribution
            FROM trigger_dev.errors_v1 FINAL
            WHERE environment_id = '${env}' AND error_fingerprint = '${group.error_fingerprint}'
            LIMIT 1`,
  });

  for (const table of ["errors_v1", "error_occurrences_v1"]) {
    await raw.command({ query: `OPTIMIZE TABLE trigger_dev.${table} FINAL` });
  }
  await ch.close();

  console.log(`
${group.error_type} on ${group.task_identifier} recurred just now.
  fingerprint  ${group.error_fingerprint}
  message      ${group.error_message}

An armed "if it recurs" watch resolves on its next check (≤5 min) with
"Error ${group.error_fingerprint.slice(0, 8)} happened again". Arm the watch FIRST — the
watch only counts occurrences after the moment it was created.

  Errors → this group → Watch… (tick "Investigate attention outcomes" under
  Customize to get the investigation conducted for you when it fires).`);
}

// ---------------------------------------------------------------------------
// Real runs, for the run watches
// ---------------------------------------------------------------------------

async function triggerHelloWorld(taskId: string, seconds: number) {
  const project = await prisma.project.findFirst({
    where: { externalRef: HELLO_WORLD_PROJECT_REF },
  });
  if (!project) {
    fail(`No hello-world project. Run \`pnpm run db:seed\` first (it creates the References org).`);
  }
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: { projectId: project.id, type: "DEVELOPMENT" },
    select: { apiKey: true, slug: true },
  });
  if (!environment?.apiKey) {
    fail(`hello-world has no dev environment key. Re-run \`pnpm run db:seed\`.`);
  }

  const response = await fetch(`${APP_ORIGIN}/api/v1/tasks/${taskId}/trigger`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${environment.apiKey}`,
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
        `Is the task deployed? \`${taskId}\` lives in the references repo — see\n` +
        `internal-packages/dashboard-agent/SCENARIOS.md for its source, then run\n` +
        `\`pnpm exec trigger dev --profile local\` in projects/hello-world.`
    );
  }
  return { runId: body.id, projectSlug: project.slug, envSlug: environment.slug };
}

async function runScenario(kind: "fail" | "succeed", seconds: number) {
  const taskId = kind === "fail" ? SLOW_FAIL_TASK_ID : SLOW_SUCCEED_TASK_ID;
  const { runId } = await triggerHelloWorld(taskId, seconds);
  console.log(`
${taskId} is running for ~${seconds}s: ${runId}

Next, in the dashboard (hello-world project, dev):
  Runs → ${runId} → Watch… → Customize
    "when it finishes"  → resolves ${
      kind === "fail" ? `"Run ${runId} failed"` : `"Run ${runId} finished"`
    }
    "if it fails"       → ${
      kind === "fail"
        ? `resolves "Run ${runId} failed"; tick "Investigate attention outcomes" to get the failure investigated for you`
        : `can't happen — when the run succeeds the watch resolves "Run ${runId} succeeded" instead`
    }
  A run watch can check every minute, so pick a window with room for the sleep.`);
}

// ---------------------------------------------------------------------------
// Health, delegated to the seeder
// ---------------------------------------------------------------------------

/** The seeder owns the flip: spawn it rather than re-derive its window arithmetic. */
async function healthFlip(mode: "degrade" | "recover") {
  const script = fileURLToPath(new URL("./seed-agent-examples.mts", import.meta.url));
  const code = await new Promise<number>((resolve) => {
    const child = spawn("pnpm", ["exec", "tsx", script, `--${mode}`], {
      stdio: "inherit",
      cwd: fileURLToPath(new URL(".", import.meta.url)),
    });
    child.on("exit", (exitCode) => resolve(exitCode ?? 1));
    child.on("error", () => resolve(1));
  });
  if (code !== 0) fail(`The seeder's --${mode} exited with ${code}.`);
  console.log(
    mode === "recover"
      ? `\nAn armed "when it recovers" watch resolves on its next check (≤5 min) with "Health recovered".`
      : `\nAsk the agent "is anything wrong right now?" for the degraded report card.`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Watch / Investigate scenarios over the seeded agent-examples stand.

Usage: pnpm --filter webapp run scenarios:watch -- <verb> [args] [--env prod|dev]

Verbs:
  queue:fill <queue> <depth> [--age-min N]
                    stage <depth> runs on the queue (and the env-level key).
                    --age-min backdates the oldest one, for the wait-limit watch.
  queue:grow <queue> <depth>
                    same thing, named for the "if it grows" watch.
  queue:drain <queue>
                    empty the queue. Arm the drain watch first.
  error:recur       one fresh occurrence of the stand's seeded error group.
                    Arm the recurrence watch first — it only counts what comes
                    after it was created.
  run:fail [sec]    trigger hello-world's ${SLOW_FAIL_TASK_ID} (default ${DEFAULT_RUN_SECONDS}s).
  run:succeed [sec] trigger hello-world's ${SLOW_SUCCEED_TASK_ID} (default ${DEFAULT_RUN_SECONDS}s).
  health:degrade    the stand's report goes critical (the seeder's --degrade).
  health:recover    the stand's report goes ok (the seeder's --recover).

Prerequisites: \`pnpm run docker\`, \`pnpm run db:seed\`,
\`pnpm --filter webapp run db:seed:agent-examples\`, a running webapp, a running
\`trigger dev\` for the agent project, ANTHROPIC_API_KEY exported — and, for the
run verbs, \`trigger dev\` in the references repo's projects/hello-world.

Walkthroughs: internal-packages/dashboard-agent/SCENARIOS.md`);
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

  switch (verb) {
    case "queue:fill":
    case "queue:grow":
      await queueFill(
        await resolveStand(flags.env),
        requireQueueName(),
        requireDepth(),
        ageMinutes()
      );
      break;
    case "queue:drain":
      await queueDrain(await resolveStand(flags.env), requireQueueName());
      break;
    case "error:recur":
      await errorRecur(await resolveStand(flags.env));
      break;
    case "run:fail":
      await runScenario("fail", seconds());
      break;
    case "run:succeed":
      await runScenario("succeed", seconds());
      break;
    case "health:degrade":
      await healthFlip("degrade");
      break;
    case "health:recover":
      await healthFlip("recover");
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
