import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { cancelWatch, getWatch, recordWatchCheck } from "@internal/dashboard-agent-db";
import { z } from "zod";
import { dashboardAgentDb } from "~/services/dashboardAgentDb.server";
import { logger } from "~/services/logger.server";
import { checkWatch, previousCheckFacts } from "~/services/dashboardAgentWatchChecks";
import { watchCheckDeps } from "~/services/dashboardAgentWatchChecks.server";
import {
  armDashboardAgentWatchBatch,
  authorizeWatchEnvironment,
} from "~/services/dashboardAgentWatches.server";
import {
  WATCH_TOKEN_GRACE_MS,
  bearerToken,
  verifyWatchTokenFromRequest,
} from "~/services/dashboardAgentWatchToken.server";

/**
 * `POST /api/v1/dashboard-agent/watches/:watchId/check` — private per-watch check.
 * The watcher task calls it once per tick with the watch's token.
 *
 * Security model: the token only names a watch; the row is the authority on
 * lifecycle and on the immutable project/environment/user snapshot; the user is
 * re-authorized against that snapshot on every call, and a revoked user gets the
 * watch cancelled here before any environment data is read.
 *
 * The route never transitions the watch to fired/expired and never advances the
 * tick counter. The watcher task owns both, so exactly one component decides when
 * the user is told and nothing here can fork the tick chain.
 *
 * It also hands a watch over to its group's batch chain: it makes sure a chain is
 * running for the watch's (environment, cadence) group and answers
 * `batched: true` when one is, at which point the caller stops rescheduling its
 * own per-watch chain.
 */

const ParamsSchema = z.object({ watchId: z.string().min(1) });

/**
 * Best-effort: the verdict is what this route owes its caller, so a chain that
 * couldn't be armed returns `false` and the next check tries again.
 */
async function ensureBatchChain(watch: {
  id: string;
  environmentId: string;
  spec: { checkEveryMinutes: number };
}): Promise<boolean> {
  try {
    const { running } = await armDashboardAgentWatchBatch({
      environmentId: watch.environmentId,
      cadenceMinutes: watch.spec.checkEveryMinutes,
    });
    return running;
  } catch (error) {
    logger.error("Dashboard agent watch check: couldn't arm the batch chain", {
      watchId: watch.id,
      environmentId: watch.environmentId,
      error,
    });
    return false;
  }
}

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

  // A valid token for a different watch is 403, not 401: the caller is
  // authenticated, just not for this resource.
  if (claims.watchId !== watchId) {
    return json({ error: "Not allowed for this watch", code: "watch_mismatch" }, { status: 403 });
  }

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

  // Terminal watches are never checked again, whatever the token says.
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
    // Past the deadline only the final evaluation is allowed, and only inside the
    // grace window the token is valid for.
    const graceEnds = watch.expiresAt.getTime() + WATCH_TOKEN_GRACE_MS;
    if (body.final !== true || now.getTime() > graceEnds) {
      return json(
        { error: "This watch has expired", code: "expired", expiresAt: watch.expiresAt },
        { status: 403 }
      );
    }
  }

  // Everything below reads or writes a tenant's data, so failures are logged with
  // whose tick failed, then rethrown unchanged.
  try {
    // Re-authorize the initiating user before any environment data is read, so a
    // revoked user's tick can't observe anything.
    const authorization = await authorizeWatchEnvironment({
      userId: watch.userId,
      organizationId: watch.organizationId,
      projectId: watch.projectId,
      environmentId: watch.environmentId,
    });

    if (!authorization.ok) {
      // The watch must not survive the access it was created with. Cancellation is
      // never notified, so `deliveryStatus` stays `not_required`.
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
      // `previous` is the last check's facts, off the row. A tick that couldn't read
      // anything freezes a streak instead of resetting it.
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

    // Recorded even on the final evaluation: `lastResult` is what the notification
    // reads. Guarded on `active`, so a concurrent fire/expire wins and this no-ops.
    await recordWatchCheck(dashboardAgentDb, {
      id: watchId,
      lastResult: {
        result: outcome.result,
        facts: outcome.facts,
        observed: outcome.observed,
        final: body.final === true,
      },
    });

    const batched = await ensureBatchChain(watch);

    // `observed` travels with the verdict: the task writes it onto the row in the
    // same statement as the resolution, so no delivery surface re-reads the source.
    return json({
      result: outcome.result,
      facts: outcome.facts,
      observed: outcome.observed,
      batched,
    });
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
