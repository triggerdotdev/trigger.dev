import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { watchSpecSchema } from "@internal/dashboard-agent-contracts";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { resolveWatchEmailAlertsState } from "~/services/dashboardAgentWatchAlerts.server";
import {
  authorizeWatchEnvironmentById,
  createDashboardAgentWatch,
  resolveChatWatchContext,
} from "~/services/dashboardAgentWatches.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

/**
 * `POST /api/v1/dashboard-agent/watches` — programmatic watch creation.
 *
 * Currently caller-less by design: the dashboard chat creates watches through
 * the configuration card (`watch-create` resource intent), and `schedule_watch`
 * only proposes that card. Kept for MCP — an external agent has no card surface,
 * so its watch creation lands here (the creation-time check, dedup, and caps are
 * already in place).
 *
 * Accepts ONLY the dashboard agent's delegated user-actor token. Unlike the other
 * UAT routes it does not also take a PAT: this endpoint creates something that
 * later runs in the background on a user's behalf, so the only caller it trusts is
 * the agent acting for the signed-in user in a live chat.
 *
 * Order of authority:
 *
 *   - the ENVIRONMENT comes from the TOKEN, which the dashboard minted for the
 *     environment the current turn is being taken in. Nothing in the request body
 *     can widen or move it: an `environmentId`/`projectRef` that disagrees is a
 *     400, and a token with no environment scope can't create a watch at all. A
 *     chat's stored context is never consulted — it's a snapshot from whenever the
 *     chat started, and would silently bind a watch to a stale environment.
 *   - the CHAT must still be a live chat owned by that user, or a watch could be
 *     bound to (and later wake) someone else's conversation. That scoped read also
 *     yields the chat's org, which the token's environment must match.
 *   - the environment is then re-authorized through the same path a background
 *     check uses, so a watch is only created for an environment its user can reach
 *     right now.
 */

const BodySchema = z.object({
  spec: watchSpecSchema,
  chatId: z.string().min(1),
  /**
   * The resolution action the user consented to at creation (§6): after an
   * attention outcome the wake turn may open an investigation. Off unless the
   * caller sends it — the agent may only send it on an explicit ask.
   */
  investigateOnAttention: z.boolean().optional(),
  /**
   * Echoes of the turn's environment, if the caller sends them. Not overrides:
   * they're only ever checked against the token's environment scope, which is the
   * canonical `RuntimeEnvironment.id` (VERDICTS §3).
   */
  projectRef: z.string().min(1).optional(),
  environmentId: z.string().min(1).optional(),
});

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const authentication = await authenticateUatOrApiRequest(request);
  if (!authentication?.userActor) {
    return json({ error: "Invalid or missing access token" }, { status: 401 });
  }
  if (authentication.userActor.client !== "dashboard-agent") {
    return json({ error: "Not allowed", code: "forbidden_client" }, { status: 403 });
  }
  const userId = authentication.userActor.userId;
  // The environment this turn is scoped to. Absent means the turn was minted
  // without one, and there is nothing to fall back to that we'd trust.
  const environmentId = authentication.userActor.environmentId;
  if (!environmentId) {
    return json(
      { error: "This chat has no environment context to watch in.", code: "invalid_target" },
      { status: 400 }
    );
  }

  // The try guards the parse and nothing else: a malformed body is a 400, and the
  // shape check below it answers for itself.
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ error: "Invalid watch request", code: "invalid_request" }, { status: 400 });
  }

  const parsedBody = BodySchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return json({ error: "Invalid watch request", code: "invalid_request" }, { status: 400 });
  }
  const parsed = parsedBody.data;

  // A body that names a different environment than the turn is a bug or an
  // attempt to move the watch — either way, refuse rather than silently pick one.
  if (parsed.environmentId && parsed.environmentId !== environmentId) {
    return json(
      {
        error: "That environment isn't the one this chat is open in.",
        code: "environment_mismatch",
      },
      { status: 400 }
    );
  }

  try {
    // Ownership — a chat this user doesn't own doesn't exist as far as this
    // endpoint is concerned, and nothing is written.
    const chat = await resolveChatWatchContext({ chatId: parsed.chatId, userId });
    if (!chat) {
      return json({ error: "Chat not found", code: "chat_not_found" }, { status: 404 });
    }

    // The same authorization a background check applies, so a watch is only ever
    // created for an environment its user can reach right now.
    const environment = await authorizeWatchEnvironmentById({ userId, environmentId });
    if (!environment) {
      return json({ error: "Environment not found", code: "invalid_target" }, { status: 404 });
    }
    // A chat belongs to one org; its watches can't point at another org's env.
    if (environment.organizationId !== chat.organizationId) {
      return json({ error: "Environment not found", code: "invalid_target" }, { status: 404 });
    }
    // Same check as `environmentId`, for callers that send the project instead.
    if (parsed.projectRef && environment.project.externalRef !== parsed.projectRef) {
      return json(
        {
          error: "That project isn't the one this chat is open in.",
          code: "environment_mismatch",
        },
        { status: 400 }
      );
    }

    const result = await createDashboardAgentWatch({
      environment,
      userId,
      chatId: parsed.chatId,
      spec: parsed.spec,
      investigateOnAttention: parsed.investigateOnAttention,
    });

    if (!result.ok) {
      const status =
        result.code === "limit_reached" || result.code === "duplicate"
          ? 409
          : result.code === "invalid_target"
            ? 404
            : // The chat was deleted while the create was in flight.
              result.code === "chat_not_found"
              ? 404
              : result.code === "not_configured"
                ? 501
                : 500;
      return json(
        {
          error: result.error,
          code: result.code,
          ...(result.existingId ? { existingId: result.existingId } : {}),
        },
        { status }
      );
    }

    // The one-shot result block (§2.2/§4.1): the immediate check answered the
    // request, so there is no watch, no id, and nothing to cancel. The caller
    // renders it as a deterministic result block and the agent answers from it.
    if (!result.watching) {
      return json({
        watching: false,
        identity: result.identity,
        immediate: { result: result.immediate.result, facts: result.immediate.facts },
      });
    }

    return json({
      watching: true,
      watchId: result.watchId,
      identity: result.identity,
      status: result.status,
      expiresAt: result.expiresAt.toISOString(),
      emailAlerts: await resolveWatchEmailAlertsState({ userId, environment }),
      ...(result.unavailable ? { unavailable: true } : {}),
    });
  } catch (error) {
    // A thrown Response is Remix control flow, not a failure to report.
    if (error instanceof Response) throw error;
    logger.error("Failed to create a dashboard agent watch", {
      error,
      userId,
      environmentId,
      chatId: parsed.chatId,
    });
    return json({ error: "Internal Server Error", code: "internal" }, { status: 500 });
  }
}
