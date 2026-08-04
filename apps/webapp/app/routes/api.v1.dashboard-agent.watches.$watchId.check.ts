import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { cancelWatch, getWatch, recordWatchCheck } from "@internal/dashboard-agent-db";
import { z } from "zod";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { logger } from "~/services/logger.server";
import { checkWatch, previousCheckFacts } from "~/services/dashboardAgentWatchChecks";
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
 * The route does NOT transition the watch to fired/expired, and does NOT advance
 * the tick counter. It records what the check observed (`lastCheckedAt` plus the
 * `lastResult` the notification reads) and returns the verdict; the watcher task
 * owns the fire/expire transition and the delivery, so exactly one component
 * decides when the user gets told. The tick counter likewise has exactly one
 * writer — the task's generation claim — so nothing here can fork the tick chain.
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

  // The try guards the parse and nothing else: a malformed body is a 400, and the
  // shape check below it answers for itself.
  let rawBody: unknown;
  try {
    const raw = await request.text();
    rawBody = raw.length > 0 ? JSON.parse(raw) : {};
  } catch {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const parsedBody = BodySchema.safeParse(rawBody);
  if (!parsedBody.success) return json({ error: "Invalid request body" }, { status: 400 });
  const body = parsedBody.data;

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

  // Everything from here reads or writes a tenant's data, so it runs inside a
  // boundary that names whose tick failed. Rethrown, so the caller sees exactly
  // what it saw before: the failure is only named, not handled.
  try {
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
      // `previous` is the stateful seam: the last check's facts, off the row this
      // route already holds. A tick that couldn't read anything is unwrapped rather
      // than read, so a data gap freezes a streak instead of resetting it.
      { now, since, previous: previousCheckFacts(watch.lastResult) },
      (error) =>
        logger.error("Dashboard agent watch check failed", {
          error,
          watchId,
          userId: watch.userId,
          organizationId: watch.organizationId,
          projectId: watch.projectId,
          environmentId: watch.environmentId,
        })
    );

    // Record the check even on the final evaluation: it stamps `lastCheckedAt` and
    // parks `lastResult` on the row, which is the payload the notification reads.
    // Guarded on `active`, so a concurrent fire/expire simply wins and this no-ops.
    // Never touches `tickCount` — see the note above.
    await recordWatchCheck(dashboardAgentDb, {
      id: watchId,
      lastResult: {
        result: outcome.result,
        facts: outcome.facts,
        observed: outcome.observed,
        final: body.final === true,
      },
    });

    // `observed` travels with the verdict: it is the other half of the resolved
    // result (§4.2), and the task writes it onto the row in the SAME statement as
    // the resolution, so no delivery surface has to re-read the source (§7.5).
    return json({ result: outcome.result, facts: outcome.facts, observed: outcome.observed });
  } catch (error) {
    logger.error("Dashboard agent watch check tick failed", {
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
