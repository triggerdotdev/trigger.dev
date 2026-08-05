import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { runWatchBatchCheck } from "~/services/dashboardAgentWatchBatch.server";
import { logger } from "~/services/logger.server";
import {
  bearerToken,
  verifyWatchBatchTokenFromRequest,
} from "~/services/dashboardAgentWatchToken.server";

/**
 * `POST /api/v1/dashboard-agent/watches/batch-check` — the PRIVATE batch check. One
 * call per (environment, cadence) group per cadence, in place of one call per watch.
 *
 * A thin shell: the token names the group, the body names the tick inside it, and
 * `runWatchBatchCheck` does everything else (the chain's generation claim, the
 * per-user re-authorization, the shared reads, the per-watch verdicts). The security
 * model and its ordering are documented there.
 */

const BodySchema = z.object({
  environmentId: z.string().min(1),
  cadenceMinutes: z.number().int().positive(),
  epoch: z.number().int().nonnegative(),
  tick: z.number().int().positive(),
});

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const token = bearerToken(request);
  if (!token) {
    return json(
      { error: "Invalid or missing access token", code: "unauthorized" },
      { status: 401 }
    );
  }

  const claims = await verifyWatchBatchTokenFromRequest(token);
  if (!claims) {
    return json(
      { error: "Invalid or missing access token", code: "unauthorized" },
      { status: 401 }
    );
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

  // A valid token for a DIFFERENT group is a distinct failure from a bad token: the
  // caller is authenticated, just not for this group.
  if (
    claims.environmentId !== body.environmentId ||
    claims.cadenceMinutes !== body.cadenceMinutes
  ) {
    return json({ error: "Not allowed for this group", code: "group_mismatch" }, { status: 403 });
  }

  try {
    return json(await runWatchBatchCheck(body));
  } catch (error) {
    logger.error("Dashboard agent watch batch check failed", {
      error,
      environmentId: body.environmentId,
      cadenceMinutes: body.cadenceMinutes,
      epoch: body.epoch,
      tick: body.tick,
    });
    throw error;
  }
}
