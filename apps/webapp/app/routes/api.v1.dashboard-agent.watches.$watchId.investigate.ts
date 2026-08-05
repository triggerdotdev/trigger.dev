import { getWatch, isTerminalWatchStatus } from "@internal/dashboard-agent-db";
import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import {
  kickWatchInvestigation,
  watchWantsInvestigation,
} from "~/services/dashboardAgentWatchInvestigate.server";
import { authorizeWatchEnvironment } from "~/services/dashboardAgentWatches.server";
import {
  bearerToken,
  verifyWatchTokenFromRequest,
} from "~/services/dashboardAgentWatchToken.server";
import { logger } from "~/services/logger.server";

/**
 * `POST /api/v1/dashboard-agent/watches/:watchId/investigate` — the watcher task
 * tells us it has delivered the wake for a watch whose creator pre-approved an
 * investigation, so the agent can be sent off to actually conduct it.
 *
 * Same security model as the fired callback next door: the token only names a watch,
 * the row is the authority on what happened, and the watch's initiating user is
 * re-authorized against the row's immutable project/environment before anything is
 * minted, so an investigation never outlives the access the watch was created with.
 *
 * The caller's body is ignored, so a replay can only re-ask for what the row already
 * says, and the agent dedupes on the action's stable id. The consent, the outcome,
 * the user and the environment all come off the row, so the model cannot steer them.
 */

const ParamsSchema = z.object({ watchId: z.string().min(1) });

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const parsedParams = ParamsSchema.safeParse(params);
  if (!parsedParams.success) return json({ error: "Invalid params" }, { status: 400 });
  const { watchId } = parsedParams.data;

  const token = bearerToken(request);
  if (!token) {
    return json(
      { error: "Invalid or missing access token", code: "unauthorized" },
      { status: 401 }
    );
  }

  const claims = await verifyWatchTokenFromRequest(token);
  if (!claims) {
    return json(
      { error: "Invalid or missing access token", code: "unauthorized" },
      { status: 401 }
    );
  }

  if (claims.watchId !== watchId) {
    return json({ error: "Not allowed for this watch", code: "watch_mismatch" }, { status: 403 });
  }

  const watch = await getWatch(dashboardAgentDb, { id: watchId });
  if (!watch) {
    return json({ error: "Watch not found", code: "not_found" }, { status: 404 });
  }

  // The row decides on all three counts: it has resolved, the user consented, and
  // the outcome is one the consent covers.
  if (!isTerminalWatchStatus(watch.status)) {
    return json(
      { error: `This watch is ${watch.status}`, code: "not_resolved", status: watch.status },
      { status: 409 }
    );
  }

  if (!watchWantsInvestigation(watch)) {
    // Good news, neutral news, or no consent — the wake was the whole delivery.
    return json({ ok: true, investigating: false });
  }

  const authorization = await authorizeWatchEnvironment({
    userId: watch.userId,
    organizationId: watch.organizationId,
    projectId: watch.projectId,
    environmentId: watch.environmentId,
  });

  if (!authorization.ok) {
    logger.info("Dashboard agent watch resolved, but access was revoked; no investigation", {
      watchId,
    });
    return json(
      { error: "Access to this environment was revoked", code: "access_revoked" },
      { status: 403 }
    );
  }

  // Best-effort, and never an error to the caller: the wake is already delivered and
  // marked by the time we are called, so a failed kick must not make the watcher
  // retry. A turn that never starts, or dies mid-investigation, is settled by the
  // stale-investigation sweep.
  try {
    await kickWatchInvestigation({ watch, environment: authorization.environment });
  } catch (error) {
    // A thrown Response is Remix control flow, not a failed kick.
    if (error instanceof Response) throw error;
    logger.error("Dashboard agent watch investigation could not be started", {
      error,
      watchId,
      userId: watch.userId,
      organizationId: watch.organizationId,
      projectId: watch.projectId,
      environmentId: watch.environmentId,
    });
    return json({ ok: true, investigating: false, code: "kick_failed" });
  }

  return json({ ok: true, investigating: true });
}
