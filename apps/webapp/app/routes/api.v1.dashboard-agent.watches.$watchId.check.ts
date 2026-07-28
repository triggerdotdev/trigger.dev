import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { cancelWatch, getWatch, recordWatchTick } from "@internal/dashboard-agent-db";
import { z } from "zod";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { logger } from "~/services/logger.server";
import { checkWatch } from "~/services/dashboardAgentWatchChecks";
import { watchCheckDeps } from "~/services/dashboardAgentWatchChecks.server";
import { authorizeWatchEnvironment } from "~/services/dashboardAgentWatches.server";
import {
  WATCH_TOKEN_GRACE_MS,
  bearerToken,
  verifyWatchTokenFromRequest,
} from "~/services/dashboardAgentWatchToken.server";

/**
 * `POST /api/v1/dashboard-agent/watches/:watchId/check` — the PRIVATE check
 * endpoint. The watcher task calls it once per tick with the watch's token and
 * gets back the deterministic verdict plus the facts the wake narration reads.
 *
 * Order of authority, which is the whole security model of this route:
 *
 *  1. the TOKEN only names a watch (401 if invalid, 403 if it names a different
 *     watch than the URL),
 *  2. the ROW is the authority on lifecycle — status, deadline, and the immutable
 *     project/environment/user snapshot; nothing in the request can widen it,
 *  3. the USER is re-authorized against that snapshot on EVERY call, and a revoked
 *     user gets the watch cancelled here, before any environment data is read.
 *
 * The route does NOT transition the watch to fired/expired. It records the tick
 * (which is also how the row keeps `lastResult` for the notification) and returns
 * the verdict; the watcher task owns the fire/expire transition and delivery, so
 * exactly one component decides when the user gets told.
 */

const ParamsSchema = z.object({ watchId: z.string().min(1) });

const BodySchema = z.object({
  /** The expiry evaluation: allowed after `expiresAt`, within the token's grace. */
  final: z.boolean().optional(),
});

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

  // A valid token for a DIFFERENT watch is a distinct failure from a bad token:
  // the caller is authenticated, just not for this resource.
  if (claims.watchId !== watchId) {
    return json({ error: "Not allowed for this watch", code: "watch_mismatch" }, { status: 403 });
  }

  let body: z.infer<typeof BodySchema> = {};
  try {
    const raw = await request.text();
    if (raw.length > 0) {
      const parsedBody = BodySchema.safeParse(JSON.parse(raw));
      if (!parsedBody.success) return json({ error: "Invalid request body" }, { status: 400 });
      body = parsedBody.data;
    }
  } catch {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const watch = await getWatch(dashboardAgentDb, { id: watchId });
  if (!watch) {
    return json({ error: "Watch not found", code: "not_found" }, { status: 404 });
  }

  // Terminal watches are immutable — never checked again, whatever the token says.
  if (watch.status !== "active") {
    return json(
      {
        error: `This watch is ${watch.status}`,
        code: watch.status === "cancelled" ? "cancelled" : "not_active",
        status: watch.status,
      },
      { status: 403 }
    );
  }

  const now = new Date();
  const expired = watch.expiresAt.getTime() <= now.getTime();
  if (expired) {
    // Past the deadline only the FINAL evaluation is allowed, and only inside the
    // grace window the token itself is valid for.
    const graceEnds = watch.expiresAt.getTime() + WATCH_TOKEN_GRACE_MS;
    if (body.final !== true || now.getTime() > graceEnds) {
      return json(
        { error: "This watch has expired", code: "expired", expiresAt: watch.expiresAt },
        { status: 403 }
      );
    }
  }

  // Re-authorize the INITIATING user against the watch's immutable
  // project/environment. This happens before any environment data is read, so a
  // revoked user's tick can't observe anything on the way out.
  const authorization = await authorizeWatchEnvironment({
    userId: watch.userId,
    organizationId: watch.organizationId,
    projectId: watch.projectId,
    environmentId: watch.environmentId,
  });

  if (!authorization.ok) {
    // Cancel here, atomically, before returning: the watch must not survive the
    // access it was created with. Cancellation is never notified, so
    // `deliveryStatus` stays `not_required`.
    await cancelWatch(dashboardAgentDb, { id: watchId, reason: "access_revoked" });
    return json(
      { error: "Access to this environment was revoked", code: "access_revoked" },
      { status: 403 }
    );
  }

  const since = watch.spec.since ? new Date(watch.spec.since) : watch.createdAt;
  const outcome = await checkWatch(
    watch.spec,
    watchCheckDeps(authorization.environment, now),
    { now, since },
    (error) => logger.error("Dashboard agent watch check failed", { watchId, error })
  );

  // Record the tick even on the final evaluation: it stamps `lastCheckedAt` and
  // parks `lastResult` on the row, which is the payload the notification reads.
  // Guarded on `active`, so a concurrent fire/expire simply wins and this no-ops.
  await recordWatchTick(dashboardAgentDb, {
    id: watchId,
    lastResult: { result: outcome.result, facts: outcome.facts, final: body.final === true },
  });

  return json({ result: outcome.result, facts: outcome.facts });
}
