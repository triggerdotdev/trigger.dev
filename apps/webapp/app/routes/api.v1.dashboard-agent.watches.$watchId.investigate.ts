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
 * Same security model as the fired callback next door: the TOKEN only names a
 * watch, the ROW is the authority on what happened, and the watch's initiating USER
 * is re-authorized against the row's immutable project/environment before anything
 * is minted — an investigation must never outlive the access the watch was created
 * with. The caller's body is ignored entirely, so a replay can only ever re-ask for
 * what the row already says; the agent then dedupes on the action's stable id.
 *
 * Nothing here can be steered by the model: the consent, the outcome, the user and
 * the environment all come off the row.
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

  // The row decides, on all three counts: it has to have resolved, the user has to
  // have consented, and the outcome has to be one the consent covers.
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

  // Best-effort, and deliberately not an error to the caller: the wake has already
  // been delivered and marked by the time we are called, so a failed kick must not
  // make the watcher retry anything (§6). A turn that never starts — or one that
  // dies mid-investigation — is caught by the stale-investigation sweep, which
  // settles the card instead of leaving a spinner.
  try {
    await kickWatchInvestigation({ watch, environment: authorization.environment });
  } catch (error) {
    logger.error("Dashboard agent watch investigation could not be started", { watchId, error });
    return json({ ok: true, investigating: false, code: "kick_failed" });
  }

  return json({ ok: true, investigating: true });
}
