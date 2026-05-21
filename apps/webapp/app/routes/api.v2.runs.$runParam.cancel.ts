import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { CancelTaskRunService } from "~/v3/services/cancelTaskRun.server";
import { mutateWithFallback } from "~/v3/mollifier/mutateWithFallback.server";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";

const ParamsSchema = z.object({
  runParam: z.string(),
});

type ResolvedCancelTarget =
  | { source: "pg"; friendlyId: string }
  | { source: "buffer"; friendlyId: string };

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "none",
    authorization: {
      action: "write",
      resource: (params) => ({ type: "runs", id: params.runParam }),
    },
    // Mirror the Phase A read-fallback discriminated-union pattern. The
    // route builder 404s if findResource returns null
    // (`apiBuilder.server.ts:321`), so we must check both stores here.
    // The action then re-resolves via mutateWithFallback (PG-first →
    // buffer patch → wait-and-bounce) — slightly redundant lookup but
    // keeps the helper's atomicity intact.
    findResource: async (params, auth): Promise<ResolvedCancelTarget | null> => {
      const pgRun = await $replica.taskRun.findFirst({
        where: { friendlyId: params.runParam, runtimeEnvironmentId: auth.environment.id },
        select: { friendlyId: true },
      });
      if (pgRun) return { source: "pg", friendlyId: pgRun.friendlyId };
      const buffer = getMollifierBuffer();
      const entry = buffer ? await buffer.getEntry(params.runParam) : null;
      if (
        entry &&
        entry.envId === auth.environment.id &&
        entry.orgId === auth.environment.organizationId
      ) {
        return { source: "buffer", friendlyId: params.runParam };
      }
      return null;
    },
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
