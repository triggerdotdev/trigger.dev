import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
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
export async function loader({ request, params }: LoaderFunctionArgs) {
  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const parsed = ParamsSchema.safeParse(params);
  if (!parsed.success) {
    return json({ error: "Invalid or missing run ID" }, { status: 400 });
  }

  const { runParam } = parsed.data;
  const env = authenticationResult.environment;

  // Verify the run belongs to the authenticated environment before
  // returning the parity-empty list. The response body is empty either
  // way, but other run-scoped endpoints (spans, trace, retrieve) all
  // 404 on cross-env access; matching that here means a third party
  // can't distinguish "run exists" from "doesn't exist" via this
  // endpoint either. PG-first then buffer fallback, consistent with
  // the other read paths.
  const pgRun = await $replica.taskRun.findFirst({
    where: { friendlyId: runParam, runtimeEnvironmentId: env.id },
    select: { id: true },
  });
  if (!pgRun) {
    const buffered = await findRunByIdWithMollifierFallback({
      runId: runParam,
      environmentId: env.id,
      organizationId: env.organizationId,
    });
    if (!buffered) {
      return json({ error: "Run not found" }, { status: 404 });
    }
  }

  return json({ attempts: [] }, { status: 200 });
}

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
