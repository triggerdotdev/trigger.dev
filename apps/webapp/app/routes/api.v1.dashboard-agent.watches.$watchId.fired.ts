import {
  claimWatchAlertDispatch,
  getWatch,
  releaseWatchAlertDispatch,
} from "@internal/dashboard-agent-db";
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
 * The watcher task reports a fired watch. The row is the authority on whether it fired, and
 * the initiating user is re-authorized against its snapshot before any alert is sent.
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

  // Anything that isn't a fired watch gets no alert, whatever the caller claims.
  if (watch.status !== "fired" || !watch.firedAt) {
    return json(
      { error: `This watch is ${watch.status}`, code: "not_fired", status: watch.status },
      { status: 409 }
    );
  }

  try {
    const authorization = await authorizeWatchEnvironment({
      userId: watch.userId,
      organizationId: watch.organizationId,
      projectId: watch.projectId,
      environmentId: watch.environmentId,
    });

    if (!authorization.ok) {
      // Not cancelled here: the watch is already terminal.
      logger.info("Dashboard agent watch fired, but access was revoked; no alert", { watchId });
      return json(
        { error: "Access to this environment was revoked", code: "access_revoked" },
        {
          status: 403,
        }
      );
    }

    const claimed = await claimWatchAlertDispatch(dashboardAgentDb, {
      id: watch.id,
      terminalStatus: "fired",
    });
    if (!claimed) {
      logger.info("Dashboard agent watch fired callback repeated; no second alert", { watchId });
      return json({ ok: true, alerted: false });
    }

    try {
      await enqueueWatchFiredAlert(watch, "fired");
    } catch (error) {
      await releaseWatchAlertDispatch(dashboardAgentDb, { id: watch.id, terminalStatus: "fired" });
      throw error;
    }

    return json({ ok: true, alerted: true });
  } catch (error) {
    logger.error("Dashboard agent watch fire callback failed", {
      error,
      watchId,
      userId: watch.userId,
      organizationId: watch.organizationId,
      projectId: watch.projectId,
      environmentId: watch.environmentId,
    });
    throw error;
  }
}
