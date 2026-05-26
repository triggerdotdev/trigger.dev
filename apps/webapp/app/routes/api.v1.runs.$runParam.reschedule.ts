import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { RescheduleRunRequestBody } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { getApiVersion } from "~/api/versions";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { logger } from "~/services/logger.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { RescheduleTaskRunService } from "~/v3/services/rescheduleTaskRun.server";
import { mutateWithFallback } from "~/v3/mollifier/mutateWithFallback.server";
import { parseDelay } from "~/utils/delays";

const ParamsSchema = z.object({
  runParam: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or missing API Key" }, { status: 401 });
  }

  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return json({ error: "Invalid or missing run ID" }, { status: 400 });
  }

  const anyBody = await request.json();
  const body = RescheduleRunRequestBody.safeParse(anyBody);
  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const env = authenticationResult.environment;
  // Pre-resolve the absolute Date the buffer snapshot should encode.
  // RescheduleTaskRunService expects this to be present on the body for
  // its PG-side flow; for the buffer-side patch we encode the same
  // wall-clock value so the drainer's engine.trigger sees the intended
  // delayUntil after materialisation.
  const delayUntil = await parseDelay(body.data.delay);
  if (!delayUntil) {
    return json({ error: "Invalid delay value" }, { status: 400 });
  }

  try {
    const outcome = await mutateWithFallback<Response>({
      runId: parsed.data.runParam,
      environmentId: env.id,
      organizationId: env.organizationId,
      bufferPatch: {
        type: "set_delay",
        delayUntil: delayUntil.toISOString(),
      },
      pgMutation: async (taskRun) => {
        const service = new RescheduleTaskRunService();
        const updatedRun = await service.call(taskRun, body.data);
        if (!updatedRun) {
          return json({ error: "An unknown error occurred" }, { status: 500 });
        }

        const run = await ApiRetrieveRunPresenter.findRun(updatedRun.friendlyId, env);
        if (!run) {
          return json({ error: "Run not found" }, { status: 404 });
        }
        const apiVersion = getApiVersion(request);
        const presenter = new ApiRetrieveRunPresenter(apiVersion);
        const result = await presenter.call(run, env);
        if (!result) {
          return json({ error: "Run not found" }, { status: 404 });
        }
        return json(result);
      },
      // Buffered snapshot has been patched. Run it through the same
      // ApiRetrieveRunPresenter the PG branch uses (it falls back to
      // the buffer for the SyntheticRun lookup) so the response shape
      // matches `RetrieveRunResponse` — that's what the SDK's
      // `rescheduleRun` zod-validates against. Returning a stripped
      // `{ id, delayUntil }` object fails the SDK schema on every
      // existing SDK version.
      synthesisedResponse: async () => {
        const run = await ApiRetrieveRunPresenter.findRun(parsed.data.runParam, env);
        if (!run) {
          return json({ error: "Run not found" }, { status: 404 });
        }
        const apiVersion = getApiVersion(request);
        const presenter = new ApiRetrieveRunPresenter(apiVersion);
        const result = await presenter.call(run, env);
        if (!result) {
          return json({ error: "Run not found" }, { status: 404 });
        }
        return json(result);
      },
      abortSignal: getRequestAbortSignal(),
    });

    if (outcome.kind === "not_found") {
      return json({ error: "Run not found" }, { status: 404 });
    }
    if (outcome.kind === "timed_out") {
      return json({ error: "Run materialisation timed out" }, { status: 503 });
    }
    return outcome.response;
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return json({ error: error.message }, { status: 400 });
    }
    logger.error("Failed to reschedule run", { error });
    return json({ error: "Something went wrong, please try again." }, { status: 500 });
  }
}
