import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import {
  anyResource,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { CreateTaskRunAttemptService } from "~/v3/services/createTaskRunAttempt.server";

const ParamsSchema = z.object({
  /* This is the run friendly ID */
  runParam: z.string(),
});

// Phase A5 — fixes the pre-existing route bug where GET on this URL
// returned a Remix "no loader" 400 with an internal error message. The
// route only exposed `action` (POST creates a new attempt); GET had no
// handler, so any well-intentioned SDK probe hit the framework error
// instead of a proper API response.
//
// Returns `{ attempts: [] }` for both PG and buffered runs. The detailed
// attempt list belongs on the v3 retrieve endpoint, not here — this is
// the dual of the POST that creates attempts, and the empty-list shape
// gives the parity script a stable contract to assert against.
//
// Built with createLoaderApiRoute so it matches the sibling read routes
// (spans, trace, retrieve): it accepts JWTs (`allowJWT`) with the same
// run/task/tag/batch resource scoping, and a not-found run returns 404
// with `x-should-retry: true` (`shouldRetryNotFound`) so SDK pollers keep
// retrying a run that the drainer hasn't materialised yet. PG-first then
// buffer fallback, so a third party can't distinguish "exists" from
// "doesn't exist" cross-environment.
type ResolvedRun =
  | { source: "pg"; run: NonNullable<Awaited<ReturnType<typeof findPgRun>>> }
  | { source: "buffer"; run: NonNullable<Awaited<ReturnType<typeof findRunByIdWithMollifierFallback>>> };

async function findPgRun(runId: string, environmentId: string) {
  return $replica.taskRun.findFirst({
    where: { friendlyId: runId, runtimeEnvironmentId: environmentId },
    select: { friendlyId: true, taskIdentifier: true, runTags: true, batchId: true },
  });
}

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth): Promise<ResolvedRun | null> => {
      const pgRun = await findPgRun(params.runParam, auth.environment.id);
      if (pgRun) return { source: "pg", run: pgRun };

      const buffered = await findRunByIdWithMollifierFallback({
        runId: params.runParam,
        environmentId: auth.environment.id,
        organizationId: auth.environment.organizationId,
      });
      if (buffered) return { source: "buffer", run: buffered };

      return null;
    },
    shouldRetryNotFound: true,
    authorization: {
      action: "read",
      resource: (resolved) => {
        if (resolved.source === "pg") {
          const run = resolved.run;
          const resources = [
            { type: "runs", id: run.friendlyId },
            { type: "tasks", id: run.taskIdentifier },
            ...run.runTags.map((tag) => ({ type: "tags", id: tag })),
          ];
          if (run.batchId) {
            resources.push({ type: "batch", id: BatchId.toFriendlyId(run.batchId) });
          }
          return anyResource(resources);
        }
        const run = resolved.run;
        const resources = [
          { type: "runs", id: run.friendlyId },
          ...(run.taskIdentifier ? [{ type: "tasks", id: run.taskIdentifier }] : []),
          ...run.tags.map((tag) => ({ type: "tags", id: tag })),
        ];
        if (run.batchId) {
          resources.push({ type: "batch", id: BatchId.toFriendlyId(run.batchId) });
        }
        return anyResource(resources);
      },
    },
  },
  async () => {
    return json({ attempts: [] }, { status: 200 });
  }
);

export async function action({ request, params }: ActionFunctionArgs) {
  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const parsed = ParamsSchema.safeParse(params);

  if (!parsed.success) {
    return json({ error: "Invalid or missing run ID" }, { status: 400 });
  }

  const { runParam } = parsed.data;

  const service = new CreateTaskRunAttemptService();

  try {
    const { execution } = await service.call({
      runId: runParam,
      authenticatedEnv: authenticationResult.environment,
    });

    return json(execution, { status: 200 });
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return json({ error: error.message }, { status: error.status ?? 422 });
    }

    logger.error("Failed to create run attempt", { error });
    return json({ error: "Something went wrong, please try again." }, { status: 500 });
  }
}
