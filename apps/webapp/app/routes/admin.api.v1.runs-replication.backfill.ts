import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { type TaskRun } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { runsReplicationInstance } from "~/services/runsReplicationInstance.server";
import { FINAL_RUN_STATUSES } from "~/v3/taskStatus";

const Body = z.object({
  runIds: z.array(z.string()),
});

const MAX_BATCH_SIZE = 50;

export async function action({ request }: ActionFunctionArgs) {
  await requireAdminApiRequest(request);

  try {
    const body = await request.json();
    const { runIds } = Body.parse(body);

    logger.info("Backfilling runs", { runIds });

    const runs: TaskRun[] = [];
    for (let i = 0; i < runIds.length; i += MAX_BATCH_SIZE) {
      const batch = runIds.slice(i, i + MAX_BATCH_SIZE);
      const batchRuns = await prisma.taskRun.findMany({
        where: {
          id: { in: batch },
          status: {
            in: FINAL_RUN_STATUSES,
          },
        },
      });
      runs.push(...batchRuns);
    }

    if (!runsReplicationInstance) {
      throw new Error("Runs replication instance not found");
    }

    await runsReplicationInstance.backfill(
      runs.map((run) => ({
        ...run,
        masterQueue: run.workerQueue,
      }))
    );

    logger.info("Backfilled runs", { runs });

    return json({
      success: true,
      runCount: runs.length,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : error }, { status: 400 });
  }
}
