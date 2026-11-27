import {
  Prisma,
  type PrismaClientOrTransaction,
  type PrismaTransactionClient,
} from "@trigger.dev/database";
import { tryCatch } from "@trigger.dev/core/v3";
import { isAdditionalApiKey } from "@trigger.dev/core/v3/apiKeys";
import { z } from "zod";
import { $transaction } from "~/db.server";
import { logger } from "~/services/logger.server";
import { hashApiKey } from "~/utils/apiKeys";
import { syncSkewProtectionThresholdSignal } from "~/services/realtime/skewProtectionThresholdSignal.server";
import { findCurrentDeployment } from "~/v3/models/workerDeployment.server";
import { compareDeploymentVersions } from "~/v3/utils/deploymentVersions";
import {
  readSkewProtectionThresholds,
  type SkewProtectionThreshold,
  type SkewProtectionThresholds,
  type SkewProtectionThresholdSetBy,
} from "./skewProtectionThresholds.server";

// Every change to an environment's skew protection thresholds (its own and its tasks'): set,
// clear, and the clear on a rollback below one, each with its history row. The reads live in
// SkewProtectionThresholdPresenter.

export type SkewProtectionThresholdChangeKind = "set" | "cleared" | "cleared-by-rollback";

export type SkewProtectionThresholdChangeSource = "dashboard" | "api" | "rollback" | "migrated";

/** Who made a threshold change and from where. Recorded on the history row. */
export type SkewProtectionThresholdActor = {
  source: "dashboard" | "api";
  userId?: string;
  apiKeyName?: string;
};

/**
 * How a threshold change made with an API key names its actor in the history: an additional key
 * by its name, the environment's secret key by its last four characters. Never the key itself.
 */
export async function apiKeyActorName(
  prisma: PrismaClientOrTransaction,
  apiKey: string
): Promise<string> {
  const token = apiKey.trim();
  const last4 = token.slice(-4);
  if (!isAdditionalApiKey(token)) return `Secret key ...${last4}`;
  // A label for the history only: a failed read (the replica down) must not fail the change.
  const [error, key] = await tryCatch(
    prisma.apiKey.findFirst({ where: { keyHash: hashApiKey(token) }, select: { name: true } })
  );
  if (error) logger.warn("Couldn't read the API key's name for the history", { error });
  return key?.name ?? `API key ...${last4}`;
}

/** What a rollback (or a clear) removed: the environment's threshold and each task's. */
export type SkewProtectionThresholdsCleared = {
  environment: { version: string } | undefined;
  tasks: Array<{ task: string; version: string }>;
};

async function recordThresholdChange(
  tx: PrismaTransactionClient,
  params: {
    environmentId: string;
    /** The task whose threshold changed; absent for the environment's. */
    task?: string;
    kind: SkewProtectionThresholdChangeKind;
    version: string;
    currentVersion: string | undefined;
    source: SkewProtectionThresholdChangeSource;
    userId?: string;
    apiKeyName?: string;
  }
): Promise<void> {
  await tx.skewProtectionThresholdChange.create({
    data: {
      environmentId: params.environmentId,
      taskIdentifier: params.task ?? null,
      kind: params.kind,
      version: params.version,
      currentVersion: params.currentVersion ?? null,
      source: params.source,
      userId: params.userId ?? null,
      apiKeyName: params.apiKeyName ?? null,
    },
  });
}

export async function currentDeploymentVersion(
  tx: PrismaClientOrTransaction,
  environmentId: string
): Promise<string | undefined> {
  return (await findCurrentDeployment(environmentId, tx))?.version;
}

// NO KEY UPDATE is the lock the threshold UPDATE takes anyway. Plain FOR UPDATE also blocks every
// insert that references the environment (they take FOR KEY SHARE on this row): workers, tasks,
// queues and deployments of a deploy in progress.
async function lockThresholds(
  tx: PrismaTransactionClient,
  environmentId: string
): Promise<SkewProtectionThresholds> {
  const rows = await tx.$queryRaw<Array<{ skewProtectionThresholds: unknown }>>`
    SELECT "skewProtectionThresholds" FROM "RuntimeEnvironment" WHERE "id" = ${environmentId} FOR NO KEY UPDATE
  `;
  return readSkewProtectionThresholds(rows[0]?.skewProtectionThresholds, environmentId);
}

// The writes change one threshold in place with jsonb operators, so the task id only ever travels
// as a query parameter (never as a key of an object built here), and anything else stored in the
// value is left as it is. Callers hold the row lock from `lockThresholds`.

// The stored value and its task map, each replaced by an empty object when it isn't one.
const STORED = Prisma.sql`CASE WHEN jsonb_typeof(r."skewProtectionThresholds") = 'object' THEN r."skewProtectionThresholds" ELSE '{}'::jsonb END`;
const STORED_TASKS = Prisma.sql`CASE WHEN jsonb_typeof(r."skewProtectionThresholds" -> 'tasks') = 'object' THEN r."skewProtectionThresholds" -> 'tasks' ELSE '{}'::jsonb END`;

async function writeThreshold(
  tx: PrismaTransactionClient,
  environmentId: string,
  task: string | undefined,
  threshold: SkewProtectionThreshold
): Promise<void> {
  const json = JSON.stringify(threshold);
  const value =
    task === undefined
      ? Prisma.sql`jsonb_set(${STORED}, '{environment}', ${json}::jsonb, true)`
      : Prisma.sql`jsonb_set(
          jsonb_set(${STORED}, '{tasks}', ${STORED_TASKS}, true),
          ARRAY['tasks', ${task}]::text[],
          ${json}::jsonb,
          true
        )`;
  await tx.$executeRaw`
    UPDATE "RuntimeEnvironment" AS r
    SET "skewProtectionThresholds" = ${value}, "updatedAt" = NOW()
    WHERE r."id" = ${environmentId}
  `;
}

/** Remove thresholds; the column goes back to NULL once neither kind is left. */
async function removeThresholds(
  tx: PrismaTransactionClient,
  environmentId: string,
  remove: { environment: boolean; tasks: string[] }
): Promise<void> {
  const withoutEnvironment = remove.environment
    ? Prisma.sql`(${STORED}) - 'environment'`
    : Prisma.sql`${STORED}`;
  await tx.$executeRaw`
    UPDATE "RuntimeEnvironment" AS e
    SET "skewProtectionThresholds" = CASE
          WHEN n.value ? 'environment' OR n.value -> 'tasks' <> '{}'::jsonb THEN n.value
          ELSE NULL
        END,
        "updatedAt" = NOW()
    FROM (
      SELECT jsonb_set(
               ${withoutEnvironment},
               '{tasks}',
               (${STORED_TASKS}) - ${remove.tasks}::text[],
               true
             ) AS value
      FROM "RuntimeEnvironment" AS r
      WHERE r."id" = ${environmentId}
    ) AS n
    WHERE e."id" = ${environmentId}
  `;
}

/** Locks the environment's thresholds and returns those above `version`, the ones a switch to it clears. */
export async function lockThresholdsAbove(
  tx: PrismaTransactionClient,
  environmentId: string,
  version: string
): Promise<SkewProtectionThresholdsCleared> {
  const thresholds = await lockThresholds(tx, environmentId);
  const isAbove = (threshold: SkewProtectionThreshold) =>
    compareDeploymentVersions(version, threshold.version) < 0;
  return {
    environment:
      thresholds.environment && isAbove(thresholds.environment)
        ? { version: thresholds.environment.version }
        : undefined,
    tasks: [...thresholds.tasks]
      .filter(([, threshold]) => isAbove(threshold))
      .map(([task, threshold]) => ({ task, version: threshold.version })),
  };
}

/**
 * Clear every skew protection threshold above the deployment becoming current (a rollback below
 * it): sessions move to the current deployment, so a threshold can't be above it. Covers the
 * environment's threshold and each task's, with a history row each. Runs inside the transaction
 * that moves the current promotion. Returns what it cleared, if anything.
 */
export async function clearSkewProtectionThresholdsAbove(
  tx: PrismaTransactionClient,
  params: {
    environmentId: string;
    /** The version becoming current. */
    version: string;
    /** Who rolled back, recorded on the history rows: a dashboard user, or an API key's name. */
    userId?: string;
    apiKeyName?: string;
  }
): Promise<SkewProtectionThresholdsCleared | undefined> {
  const cleared = await lockThresholdsAbove(tx, params.environmentId, params.version);
  if (!cleared.environment && cleared.tasks.length === 0) return undefined;

  await removeThresholds(tx, params.environmentId, {
    environment: cleared.environment !== undefined,
    tasks: cleared.tasks.map(({ task }) => task),
  });
  const row = {
    environmentId: params.environmentId,
    kind: "cleared-by-rollback",
    currentVersion: params.version,
    source: "rollback",
    userId: params.userId,
    apiKeyName: params.apiKeyName,
  } as const;
  if (cleared.environment) {
    await recordThresholdChange(tx, { ...row, version: cleared.environment.version });
  }
  for (const { task, version } of cleared.tasks) {
    await recordThresholdChange(tx, { ...row, task, version });
  }
  return cleared;
}

export class SkewProtectionThresholdError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409
  ) {
    super(message);
    this.name = "SkewProtectionThresholdError";
  }
}

const VERSION_PATTERN = /^\d+(\.\d+)*$/;
/** Longer versions are refused before they're echoed in an error, logged or looked up. */
export const MAX_THRESHOLD_VERSION_LENGTH = 64;
/** Longer task ids are refused the same way. */
export const MAX_THRESHOLD_TASK_LENGTH = 256;
/**
 * A task id as the API and dashboard take it. A NUL is refused here: Postgres rejects it in a
 * query parameter, which would turn a bad request into a 500.
 */
export const ThresholdTaskId = z
  .string()
  .min(1)
  .max(MAX_THRESHOLD_TASK_LENGTH)
  .refine((task) => !task.includes("\u0000"), "A task id can't contain a NUL character");
/**
 * How many tasks of one environment can have their own threshold. The stored value is loaded with
 * the environment on every authenticated request, so it has to stay small.
 */
export const MAX_TASK_THRESHOLDS = 50;

function assertThresholdTarget(environment: { type: string }, task: string | undefined): void {
  if (environment.type === "DEVELOPMENT") {
    throw new SkewProtectionThresholdError(
      "Skew protection thresholds don't apply to development environments.",
      400
    );
  }
  if (task !== undefined && (task.length === 0 || task.length > MAX_THRESHOLD_TASK_LENGTH)) {
    throw new SkewProtectionThresholdError(
      `A task id is 1 to ${MAX_THRESHOLD_TASK_LENGTH} characters.`,
      400
    );
  }
}

/**
 * Set (or move) a skew protection threshold: the environment's, or with `task` that task's own.
 * Idempotent: setting the version it already has changes nothing. Throws
 * {@link SkewProtectionThresholdError} with the HTTP status.
 */
export async function setSkewProtectionThreshold(
  prisma: PrismaClientOrTransaction,
  params: {
    environment: { id: string; type: string };
    version: string;
    /** Only this task's sessions. Absent: every session in the environment. */
    task?: string;
    setBy: SkewProtectionThresholdSetBy;
    actor: SkewProtectionThresholdActor;
  }
): Promise<{ changed: boolean }> {
  const { environment, version, task, setBy, actor } = params;

  assertThresholdTarget(environment, task);
  if (version.length > MAX_THRESHOLD_VERSION_LENGTH) {
    throw new SkewProtectionThresholdError(
      `A deployment version is at most ${MAX_THRESHOLD_VERSION_LENGTH} characters.`,
      400
    );
  }
  if (!VERSION_PATTERN.test(version)) {
    throw new SkewProtectionThresholdError(
      `"${version}" isn't a deployment version. Versions look like 20261108.5.`,
      400
    );
  }

  const result = await $transaction(prisma, "setSkewProtectionThreshold", async (tx) => {
    const thresholds = await lockThresholds(tx, environment.id);
    const previous = task === undefined ? thresholds.environment : thresholds.tasks.get(task);

    const deployment = await tx.workerDeployment.findFirst({
      where: { environmentId: environment.id, version, status: "DEPLOYED" },
      select: { id: true },
    });
    if (!deployment) {
      throw new SkewProtectionThresholdError(
        `No deployed deployment with version ${version} in this environment.`,
        404
      );
    }

    const current = await findCurrentDeployment(environment.id, tx);
    const currentVersion = current?.version;
    if (!currentVersion || compareDeploymentVersions(currentVersion, version) < 0) {
      throw new SkewProtectionThresholdError(
        currentVersion
          ? `The current deployment (${currentVersion}) is below ${version}. Promote it first: sessions move to the current deployment, so a threshold can't be above it.`
          : `This environment has no current deployment. Promote ${version} first.`,
        409
      );
    }

    if (task !== undefined) {
      // Sessions move to the current deployment, so the task has to be in it.
      const currentTask = current?.workerId
        ? await tx.backgroundWorkerTask.findFirst({
            where: { workerId: current.workerId, slug: task },
            select: { id: true },
          })
        : null;
      if (!currentTask) {
        throw new SkewProtectionThresholdError(
          `No task "${task}" in the current deployment (${currentVersion}).`,
          404
        );
      }
      if (!previous && thresholds.tasks.size >= MAX_TASK_THRESHOLDS) {
        throw new SkewProtectionThresholdError(
          `At most ${MAX_TASK_THRESHOLDS} tasks in an environment can have their own skew protection threshold. Clear one first, or set the environment's threshold.`,
          409
        );
      }
    }

    if (previous?.version === version) return { changed: false };

    await writeThreshold(tx, environment.id, task, {
      version,
      setAt: new Date().toISOString(),
      setBy,
    });
    await recordThresholdChange(tx, {
      environmentId: environment.id,
      task,
      kind: "set",
      version,
      currentVersion,
      ...actor,
    });
    return { changed: true };
  });

  // A repeat also syncs: setting the same version again repairs a signal an earlier send lost
  // (S2 down), as the runbook says. It costs one read of the signal stream.
  if (result) {
    await syncSkewProtectionThresholdSignal(environment.id, { changed: true });
  }
  return result ?? { changed: false };
}

/** Clear the environment's threshold, or with `task` that task's own. A no-op when it isn't set. */
export async function clearSkewProtectionThreshold(
  prisma: PrismaClientOrTransaction,
  environment: { id: string; type: string },
  actor: SkewProtectionThresholdActor,
  task?: string
): Promise<{ cleared: { version: string } | undefined }> {
  assertThresholdTarget(environment, task);

  const result = await $transaction(prisma, "clearSkewProtectionThreshold", async (tx) => {
    const thresholds = await lockThresholds(tx, environment.id);
    const previous = task === undefined ? thresholds.environment : thresholds.tasks.get(task);
    if (!previous) return { cleared: undefined };

    await removeThresholds(tx, environment.id, {
      environment: task === undefined,
      tasks: task === undefined ? [] : [task],
    });
    await recordThresholdChange(tx, {
      environmentId: environment.id,
      task,
      kind: "cleared",
      version: previous.version,
      currentVersion: await currentDeploymentVersion(tx, environment.id),
      ...actor,
    });
    return { cleared: { version: previous.version } };
  });

  // A repeat clear syncs too, like a repeat set: it repairs a clear whose signal was lost.
  if (result) {
    await syncSkewProtectionThresholdSignal(environment.id, { changed: true });
  }
  return result ?? { cleared: undefined };
}

/**
 * The dashboard's set and clear (the Deployments page and the agent and task sidebars). The
 * environment is looked up through the user's membership of the project's organization, so a
 * non-member gets a 404 whatever ids they send.
 * The role check (write deployments) happens in the route, like Promote and Rollback.
 */
export async function changeSkewProtectionThresholdFromDashboard(
  prisma: PrismaClientOrTransaction,
  params: {
    /** Never the email: the name is shown to members and returned by the API. */
    user: { id: string; displayName: string | null; name: string | null };
    projectId: string;
    environmentId: string;
    /** With `task`, that task's own threshold; without, the environment's. */
    change: { type: "set"; version: string; task?: string } | { type: "clear"; task?: string };
  }
): Promise<{ message: string }> {
  const environment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: params.environmentId,
      projectId: params.projectId,
      organization: { members: { some: { userId: params.user.id } } },
    },
    select: { id: true, type: true },
  });
  if (!environment) {
    throw new SkewProtectionThresholdError("Environment not found.", 404);
  }

  const { task } = params.change;
  const name = task ? `skew protection threshold for ${task}` : "skew protection threshold";

  if (params.change.type === "clear") {
    const { cleared } = await clearSkewProtectionThreshold(
      prisma,
      environment,
      { source: "dashboard", userId: params.user.id },
      task
    );
    return {
      message: cleared
        ? `Cleared the ${name} (${cleared.version}).`
        : `There was no ${name} to clear.`,
    };
  }

  const { version } = params.change;
  await setSkewProtectionThreshold(prisma, {
    environment,
    version,
    task,
    setBy: {
      type: "user",
      id: params.user.id,
      name: params.user.displayName ?? params.user.name ?? null,
    },
    actor: { source: "dashboard", userId: params.user.id },
  });
  return {
    message: task
      ? `Set ${version} as the skew protection threshold for ${task}. Its older sessions move to the current deployment the next time they're used.`
      : `Set ${version} as the skew protection threshold. Older sessions move to the current deployment the next time they're used.`,
  };
}
