import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { watchSpecSchema } from "@internal/dashboard-agent-contracts";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { resolveWatchEmailAlertsState } from "~/services/dashboardAgentWatchAlerts.server";
import { watchErrorStatus } from "~/services/dashboardAgentWatchErrorStatus.server";
import {
  authorizeWatchEnvironmentById,
  createDashboardAgentWatch,
  resolveChatWatchContext,
} from "~/services/dashboardAgentWatches.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

/**
 * Programmatic watch creation (MCP). Only the agent's delegated user-actor token is
 * accepted, and the environment comes from it, never the body or the chat's stored context.
 */

const BodySchema = z.object({
  spec: watchSpecSchema,
  chatId: z.string().min(1),
  /** Consent for the wake turn to open an investigation. Off unless explicitly sent. */
  investigateOnAttention: z.boolean().optional(),
  /**
   * Only checked against the token's environment scope, never used in its place.
   * `environmentId` is the canonical `RuntimeEnvironment.id`, not a slug.
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
  // The environment this turn is scoped to. There is no trusted fallback.
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

  // Refuse a body naming a different environment rather than silently picking one.
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
    // A chat this user doesn't own does not exist here.
    const chat = await resolveChatWatchContext({ chatId: parsed.chatId, userId });
    if (!chat) {
      return json({ error: "Chat not found", code: "chat_not_found" }, { status: 404 });
    }

    // The same authorization a background check applies.
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
      return json(
        {
          error: result.error,
          code: result.code,
          ...(result.existingId ? { existingId: result.existingId } : {}),
        },
        { status: watchErrorStatus(result.code) }
      );
    }

    // One-shot: the immediate check answered, so there is no watch row and no id.
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
