import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { env as appEnv } from "~/env.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { CancelTaskRunService } from "~/v3/services/cancelTaskRun.server";
import { mutateWithFallback } from "~/v3/mollifier/mutateWithFallback.server";
import {
  resolveRunForMutation,
  type ResolvedRunForMutation,
} from "~/v3/mollifier/resolveRunForMutation.server";

const ParamsSchema = z.object({
  runParam: z.string(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "none",
    authorization: {
      action: "write",
      resource: (params) => ({ type: "runs", id: params.runParam }),
    },
    // PG-or-buffer resolver. Returning null here would 404 BEFORE the
    // action runs (`apiBuilder.server.ts:321`), so buffered cancels need
    // a buffer check at this layer too. Logic lives in a helper so the
    // three paths (PG hit, buffer hit, both miss) are unit-tested
    // independently of the route builder. The action's mutateWithFallback
    // call repeats the lookup atomically — slightly redundant but keeps
    // wait-and-bounce semantics intact.
    findResource: async (params, auth): Promise<ResolvedRunForMutation | null> =>
      resolveRunForMutation({
        runParam: params.runParam,
        environmentId: auth.environment.id,
        organizationId: auth.environment.organizationId,
      }),
  },
  async ({ params, authentication }) => {
    const runId = params.runParam;
    const env = authentication.environment;
    const cancelledAt = new Date();
    const cancelReason = "Canceled by user";

    const outcome = await mutateWithFallback({
      runId,
      environmentId: env.id,
      organizationId: env.organizationId,
      bufferPatch: {
        type: "mark_cancelled",
        cancelledAt: cancelledAt.toISOString(),
        cancelReason,
      },
      pgMutation: async (taskRun) => {
        const service = new CancelTaskRunService();
        try {
          await service.call(taskRun);
        } catch {
          return json({ error: "Internal Server Error" }, { status: 500 });
        }
        return json({ id: taskRun.friendlyId }, { status: 200 });
      },
      synthesisedResponse: () => json({ id: runId }, { status: 200 }),
      abortSignal: getRequestAbortSignal(),
      safetyNetMs: appEnv.TRIGGER_MOLLIFIER_MUTATE_SAFETY_NET_MS,
      pollStepMs: appEnv.TRIGGER_MOLLIFIER_MUTATE_POLL_STEP_MS,
      maxPollStepMs: appEnv.TRIGGER_MOLLIFIER_MUTATE_MAX_POLL_STEP_MS,
      backoffFactor: appEnv.TRIGGER_MOLLIFIER_MUTATE_BACKOFF_FACTOR,
    });

    if (outcome.kind === "not_found") {
      return json({ error: "Run not found" }, { status: 404 });
    }
    if (outcome.kind === "timed_out") {
      return json({ error: "Run materialisation timed out" }, { status: 503 });
    }
    return outcome.response;
  }
);

export { action };
