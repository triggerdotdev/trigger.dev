import { getWatch } from "@internal/dashboard-agent-db";
import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { enqueueWatchFiredAlert } from "~/services/dashboardAgentWatchAlerts.server";
import { authorizeWatchEnvironment } from "~/services/dashboardAgentWatches.server";
import {
  bearerToken,
  verifyWatchTokenFromRequest,
} from "~/services/dashboardAgentWatchToken.server";
import { logger } from "~/services/logger.server";

/**
 * `POST /api/v1/dashboard-agent/watches/:watchId/fired` — the watcher task tells
 * us a watch fired, so the project's alert channels can be notified.
 *
 * Same security model as the check endpoint next door: the TOKEN only names a
 * watch, the ROW is the authority on whether it actually fired, and the watch's
 * initiating USER is re-authorized against the row's immutable
 * project/environment before anything is sent — an alert must never outlive the
 * access the watch was created with.
 *
 * The route asserts nothing beyond "this row is fired": the caller's body is
 * ignored entirely, so a replay can only ever re-announce what the row already
 * says. Repeat calls are harmless because the alert job is keyed on the watch
 * (`watch-alert:{watchId}`), so the fan-out happens at most once.
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

  // The row decides. Anything that isn't a fired watch gets no alert, whatever
  // the caller claims.
  if (watch.status !== "fired" || !watch.firedAt) {
    return json(
      { error: `This watch is ${watch.status}`, code: "not_fired", status: watch.status },
      { status: 409 }
    );
  }

  const authorization = await authorizeWatchEnvironment({
    userId: watch.userId,
    organizationId: watch.organizationId,
    projectId: watch.projectId,
    environmentId: watch.environmentId,
  });

  if (!authorization.ok) {
    // Not cancelled here (the watch is already terminal) — just silence.
    logger.info("Dashboard agent watch fired, but access was revoked; no alert", { watchId });
    return json(
      { error: "Access to this environment was revoked", code: "access_revoked" },
      {
        status: 403,
      }
    );
  }

  await enqueueWatchFiredAlert(watch, "fired");

  return json({ ok: true });
}
