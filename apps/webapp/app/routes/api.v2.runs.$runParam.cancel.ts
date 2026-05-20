import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { CancelTaskRunService } from "~/v3/services/cancelTaskRun.server";
import { mutateWithFallback } from "~/v3/mollifier/mutateWithFallback.server";

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
    // PG-side authorisation is performed inside mutateWithFallback. Routing
    // the resource through findResource (which would require a PG-or-buffer
    // resolved discriminated union here) would duplicate the resolution
    // mutateWithFallback already does, so we pass `null` to signal "open"
    // and let the helper do the lookup atomically with the mutation.
    findResource: async () => null,
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
