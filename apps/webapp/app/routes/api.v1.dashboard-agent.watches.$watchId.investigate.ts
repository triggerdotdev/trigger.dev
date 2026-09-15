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
 * The watcher task reports a delivered wake for a pre-approved investigation. The caller's
 * body is ignored: consent, outcome, user and environment all come off the row.
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

  if (!isTerminalWatchStatus(watch.status)) {
    return json(
      { error: `This watch is ${watch.status}`, code: "not_resolved", status: watch.status },
      { status: 409 }
    );
  }

  if (!watchWantsInvestigation(watch)) {
    // No consent, or an outcome consent doesn't cover: the wake was the whole delivery.
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

  // Never an error to the caller: the wake is already delivered and marked, so a failed
  // kick must not make the watcher retry. The stale-investigation sweep settles it.
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
