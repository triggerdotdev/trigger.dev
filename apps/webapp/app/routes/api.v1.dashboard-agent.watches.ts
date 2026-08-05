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
 * `POST /api/v1/dashboard-agent/watches` — programmatic watch creation, for callers
 * with no configuration card surface (MCP). The dashboard chat creates watches
 * through the `watch-create` card instead.
 *
 * Accepts only the dashboard agent's delegated user-actor token, and not a PAT: a
 * watch later runs in the background on a user's behalf, so the only trusted caller
 * is the agent acting for the signed-in user in a live chat.
 *
 * Order of authority:
 *
 *   - the environment comes from the token, minted for the environment this turn is
 *     taken in. A body `environmentId`/`projectRef` that disagrees is a 400, and a
 *     token with no environment scope can't create a watch. The chat's stored
 *     context is never used: it is a snapshot from when the chat started and would
 *     bind the watch to a stale environment.
 *   - the chat must be a live chat owned by that user, or a watch could later wake
 *     someone else's conversation. That read also yields the chat's org, which the
 *     token's environment must match.
 *   - the environment is re-authorized through the same path a background check
 *     uses, so a watch is only created for an environment its user can reach now.
 */

const BodySchema = z.object({
  spec: watchSpecSchema,
  chatId: z.string().min(1),
  /**
   * Consent recorded at creation: after an attention outcome the wake turn may open
   * an investigation. Off unless the caller sends it, and the agent may only send it
   * on an explicit ask.
   */
  investigateOnAttention: z.boolean().optional(),
  /**
   * Echoes of the turn's environment, never overrides: they are only checked against
   * the token's environment scope. `environmentId` is the canonical
   * `RuntimeEnvironment.id`, not a slug, because `(projectId, slug)` is not unique —
   * every developer gets their own `dev` row.
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
  // The environment this turn is scoped to. Absent means there is nothing to fall
  // back to that we would trust.
  const environmentId = authentication.userActor.environmentId;
  if (!environmentId) {
    return json(
      { error: "This chat has no environment context to watch in.", code: "invalid_target" },
      { status: 400 }
    );
  }

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

  // A body naming a different environment than the turn is a bug or an attempt to
  // move the watch. Refuse rather than silently picking one.
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
    // A chat this user doesn't own does not exist here, and nothing is written.
    const chat = await resolveChatWatchContext({ chatId: parsed.chatId, userId });
    if (!chat) {
      return json({ error: "Chat not found", code: "chat_not_found" }, { status: 404 });
    }

    // The same authorization a background check applies, so a watch is only created
    // for an environment its user can reach now.
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

    // One-shot: the immediate check answered the request, so there is no watch, no
    // id, and nothing to cancel.
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
