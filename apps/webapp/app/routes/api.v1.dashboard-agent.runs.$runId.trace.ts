import { json } from "@remix-run/server-runtime";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
import { getDashboardAgentRunTrace } from "~/services/dashboardAgentRunTrace.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { runStore } from "~/v3/runStore.server";

/**
 * Agent-only trace read. Same spans as GET /api/v1/runs/:runId/trace, but
 * store-uniform: durations in milliseconds and span events filtered to the customer-visible set.
 */

const ParamsSchema = z.object({
  runId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "none",
    findResource: async (params, auth) =>
      runStore.findRun(
        { friendlyId: params.runId, runtimeEnvironmentId: auth.environment.id },
        $replica
      ),
    authorization: {
      action: "read",
      resource: (run) => {
        const resources = [
          { type: "runs", id: run.friendlyId },
          { type: "tasks", id: run.taskIdentifier },
          ...run.runTags.map((tag) => ({ type: "tags", id: tag })),
        ];

        if (run.batchId) {
          resources.push({ type: "batch", id: BatchId.toFriendlyId(run.batchId) });
        }

        return anyResource(resources);
      },
    },
  },
  async ({ resource: run, authentication }) => {
    const result = await getDashboardAgentRunTrace({
      run,
      environmentId: authentication.environment.id,
      organizationId: authentication.environment.organization.id,
      prisma: $replica,
    });

    if (!result) {
      return json({ error: "Trace not found" }, { status: 404 });
    }

    return json(result, { status: 200 });
  }
);
