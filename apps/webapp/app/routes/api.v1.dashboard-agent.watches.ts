import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { watchSpecSchema } from "@internal/dashboard-agent-contracts";
import { z } from "zod";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import {
  canUseDashboardAgentAlerts,
  DASHBOARD_AGENT_WATCH_ALERT_TYPE,
} from "~/services/dashboardAgentWatchAlerts.server";
import {
  authorizeWatchEnvironmentById,
  createDashboardAgentWatch,
  resolveChatWatchContext,
} from "~/services/dashboardAgentWatches.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

/**
 * `POST /api/v1/dashboard-agent/watches` — the agent's `schedule_watch` adapter.
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

  let parsed: z.infer<typeof BodySchema>;
  try {
    const result = BodySchema.safeParse(await request.json());
    if (!result.success) {
      return json({ error: "Invalid watch request", code: "invalid_request" }, { status: 400 });
    }
    parsed = result.data;
  } catch {
    return json({ error: "Invalid watch request", code: "invalid_request" }, { status: 400 });
  }

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
    });

    if (!result.ok) {
      const status =
        result.code === "limit_reached" || result.code === "duplicate"
          ? 409
          : result.code === "invalid_target"
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

    return json({
      watchId: result.watchId,
      identity: result.identity,
      status: result.status,
      expiresAt: result.expiresAt.toISOString(),
      emailAlerts: await resolveEmailAlertsState({ userId, environment }),
      ...(result.immediate ? { immediate: result.immediate } : {}),
    });
  } catch (error) {
    logger.error("Failed to create a dashboard agent watch", { error });
    return json({ error: "Internal Server Error", code: "internal" }, { status: 500 });
  }
}

/**
 * Whether a fired watch in this environment would already reach the user outside
 * the chat, so the agent knows whether to offer an email alert when it confirms a
 * new watch:
 *
 *   - `subscribed`  — an enabled channel here already subscribes to watch fires
 *                     (any channel type counts: email, Slack, webhook), so there
 *                     is nothing to offer.
 *   - `unavailable` — the plan or feature gate denies alerts. Say nothing: don't
 *                     advertise what the user can't have.
 *   - `none`        — alerts are possible and nothing is subscribed yet.
 *
 * Advisory only. This annotates a watch that is already created, so every failure
 * is `none` — the quiet answer — and never turns into a failed creation.
 */
async function resolveEmailAlertsState(params: {
  userId: string;
  environment: AuthenticatedEnvironment;
}): Promise<"subscribed" | "none" | "unavailable"> {
  const { userId, environment } = params;
  try {
    // The same predicate the delivery job selects channels with, so "subscribed"
    // means a fire would actually be delivered.
    const channel = await $replica.projectAlertChannel.findFirst({
      where: {
        projectId: environment.project.id,
        enabled: true,
        alertTypes: { has: DASHBOARD_AGENT_WATCH_ALERT_TYPE },
        environmentTypes: { has: environment.type },
      },
      select: { id: true },
    });
    if (channel) return "subscribed";

    const gate = await canUseDashboardAgentAlerts({
      userId,
      organizationId: environment.organizationId,
      organizationSlug: environment.organization.slug,
      orgFeatureFlags: environment.organization.featureFlags as Record<string, unknown> | null,
    });
    return gate.allowed ? "none" : "unavailable";
  } catch (error) {
    logger.error("Failed to resolve dashboard agent watch alert state", { error });
    return "none";
  }
}
