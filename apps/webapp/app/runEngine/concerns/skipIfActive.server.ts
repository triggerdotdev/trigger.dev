import { Prisma, type PrismaClientOrTransaction, type TaskRun } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import type { TriggerTaskRequest } from "../types";

export type SkipIfActiveConcernResult =
  | { wasSkipped: true; run: TaskRun }
  | { wasSkipped: false };

/**
 * DB-level `TaskRunStatus` values that represent a run that has not reached
 * a terminal state — i.e. still counts as "active" for dedup purposes.
 * Mirrors the non-final statuses in `TaskRunStatus` (see
 * `internal-packages/database/prisma/schema.prisma`).
 */
const ACTIVE_TASK_RUN_STATUSES = [
  "DELAYED",
  "PENDING",
  "PENDING_VERSION",
  "WAITING_FOR_DEPLOY",
  "DEQUEUED",
  "EXECUTING",
  "WAITING_TO_RESUME",
  "RETRYING_AFTER_FAILURE",
  "PAUSED",
] as const;

/**
 * Implements the `skipIfActive` trigger option.
 *
 * When `body.options.skipIfActive === true` and at least one tag is set, the
 * concern looks for any in-flight TaskRun with:
 *
 *   runtimeEnvironmentId = <env>
 *   taskIdentifier       = <task>
 *   status IN (non-terminal)
 *   runTags           @> <supplied tags>
 *
 * If found, the existing run is returned and the trigger is short-circuited.
 * If not found, the caller proceeds to create a new run as usual.
 *
 * Intended use case: cron-style scanners that poll at a fixed cadence but
 * should drop duplicate triggers while a prior invocation is still running —
 * without generating queue backlog (`concurrencyKey`) or caching successful
 * completions (`idempotencyKey`).
 */
export class SkipIfActiveConcern {
  constructor(private readonly prisma: PrismaClientOrTransaction) {}

  async handleTriggerRequest(request: TriggerTaskRequest): Promise<SkipIfActiveConcernResult> {
    if (request.body.options?.skipIfActive !== true) {
      return { wasSkipped: false };
    }

    const rawTags = request.body.options?.tags;
    const tags = Array.isArray(rawTags) ? rawTags : rawTags ? [rawTags] : [];

    if (tags.length === 0) {
      // `skipIfActive` requires a tag scope — without tags, every run of this
      // task would dedup against every other, which is rarely the intent.
      // Treat as no-op rather than silently matching.
      logger.debug("[SkipIfActiveConcern] skipIfActive=true with no tags — skipping the check", {
        taskIdentifier: request.taskId,
      });
      return { wasSkipped: false };
    }

    // `runTags @> ARRAY[...]::text[]` hits the GIN ArrayOps index on
    // `TaskRun.runTags` and AND-matches every supplied tag. Bounded by
    // runtimeEnvironmentId + taskIdentifier + status via existing indexes.
    const statusArray = Prisma.sql`ARRAY[${Prisma.join(
      ACTIVE_TASK_RUN_STATUSES.map((s) => Prisma.sql`${s}`)
    )}]::"TaskRunStatus"[]`;

    const existing = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "TaskRun"
      WHERE "runtimeEnvironmentId" = ${request.environment.id}
        AND "taskIdentifier" = ${request.taskId}
        AND status = ANY(${statusArray})
        AND "runTags" @> ${tags}::text[]
      LIMIT 1
    `;

    if (existing.length === 0) {
      return { wasSkipped: false };
    }

    const run = await this.prisma.taskRun.findUnique({ where: { id: existing[0].id } });
    if (!run) {
      // Row disappeared between the existence probe and the fetch (e.g.
      // completed + deleted mid-query). Treat as "no active run" so the
      // caller creates a fresh one instead of failing.
      return { wasSkipped: false };
    }

    logger.debug("[SkipIfActiveConcern] active run matched, skipping new trigger", {
      runId: run.id,
      taskIdentifier: request.taskId,
      environmentId: request.environment.id,
      tags,
    });

    return { wasSkipped: true, run };
  }
}
