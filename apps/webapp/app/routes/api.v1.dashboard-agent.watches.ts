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
 * The token carries a userId and nothing else, so everything else is a claim to be
 * proven:
 *
 *   - the CHAT must be a live chat owned by that user, or a watch could be bound
 *     to (and later wake) someone else's conversation. That same scoped read also
 *     yields the chat's org and its project/environment context.
 *   - the ENVIRONMENT — from the body when the caller sends one, otherwise the
 *     chat's stored context — is re-authorized through the same path a background
 *     check uses, so the agent can't name an environment its user can't reach, and
 *     must belong to the chat's org.
 */

const BodySchema = z.object({
  spec: watchSpecSchema,
  chatId: z.string().min(1),
  /**
   * Optional overrides for the chat's stored context. `environmentId` is
   * `RuntimeEnvironment.id` — the canonical environment identity (VERDICTS §3).
   * Both are re-authorized, never trusted.
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

  try {
    // Ownership first — a chat this user doesn't own doesn't exist as far as this
    // endpoint is concerned, and nothing is written.
    const chat = await resolveChatWatchContext({ chatId: parsed.chatId, userId });
    if (!chat) {
      return json({ error: "Chat not found", code: "chat_not_found" }, { status: 404 });
    }

    const environmentId = parsed.environmentId ?? chat.environmentId;
    if (!environmentId) {
      return json(
        { error: "This chat has no environment context to watch in.", code: "invalid_target" },
        { status: 400 }
      );
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
    const projectRef = parsed.projectRef ?? chat.projectRef;
    if (projectRef && environment.project.externalRef !== projectRef) {
      return json({ error: "Environment not found", code: "invalid_target" }, { status: 404 });
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
