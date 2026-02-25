import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { EvaluateAlertDefinitionService } from "./evaluateAlertDefinition.server";

/**
 * Finds all enabled AlertV2Definitions that are due for evaluation and enqueues
 * individual evaluation jobs for each one.
 *
 * A definition is due if:
 *   - lastEvaluatedAt is null (never evaluated), OR
 *   - now >= lastEvaluatedAt + evaluationIntervalSeconds
 */
export class ScheduleAlertEvaluationsService {
  public async call() {
    const now = new Date();

    // Use a raw query to efficiently find due definitions using SQL arithmetic.
    // We compare now against lastEvaluatedAt + evaluationIntervalSeconds.
    const dueDefs = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id
      FROM "public"."AlertV2Definition"
      WHERE enabled = true
        AND (
          "lastEvaluatedAt" IS NULL
          OR "lastEvaluatedAt" + ("evaluationIntervalSeconds" * INTERVAL '1 second') <= ${now}
        )
      LIMIT 1000
    `;

    if (dueDefs.length === 0) {
      return;
    }

    logger.debug("[ScheduleAlertEvaluations] Scheduling evaluations", {
      count: dueDefs.length,
    });

    // Enqueue an evaluation job for each due definition.
    // enqueue() uses a stable ID so duplicate scheduling is a no-op.
    const results = await Promise.allSettled(
      dueDefs.map((def) => EvaluateAlertDefinitionService.enqueue(def.id))
    );

    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      logger.error("[ScheduleAlertEvaluations] Some enqueues failed", {
        failedCount: failed.length,
        total: dueDefs.length,
      });
    }
  }
}
