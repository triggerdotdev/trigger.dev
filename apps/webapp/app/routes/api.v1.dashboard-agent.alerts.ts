import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type UserActorClaims } from "@trigger.dev/rbac";
import { z } from "zod";
import { $replica, prisma } from "~/db.server";
import {
  ProjectAlertEmailProperties,
  ProjectAlertSlackProperties,
} from "~/models/projectAlert.server";
import {
  resolveAgentAlertContext,
  type AgentAlertContextError,
} from "~/services/dashboardAgentAlertContext.server";
import {
  canUseDashboardAgentEmailAlerts,
  DASHBOARD_AGENT_WATCH_ALERT_TYPE,
  subscribeChannelToWatchAlerts,
  watchAlertDeduplicationKey,
} from "~/services/dashboardAgentWatchAlerts.server";
import { resolveAgentTokenScope } from "~/services/dashboardAgentTokenScope";
import { logger } from "~/services/logger.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

/**
 * `GET` lists this chat's watch alerts, `POST` subscribes the user's email. User-actor
 * token only; org-wide tokens let the request name any environment in the org.
 */

const ListQuerySchema = z.object({
  chatId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  projectRef: z.string().min(1).optional(),
});

const CreateBodySchema = z.object({
  chatId: z.string().min(1),
  channel: z.literal("email"),
  /** May only be the authenticated user's own account email. */
  email: z.string().email().optional(),
  environmentId: z.string().min(1).optional(),
  projectRef: z.string().min(1).optional(),
});

/** A token that scopes neither an environment nor an organization is unusable here. */
async function authenticate(
  request: Request
): Promise<{ userId: string; claims: UserActorClaims } | { error: Response }> {
  const authentication = await authenticateUatOrApiRequest(request);
  const actor = authentication?.userActor;
  if (!actor || actor.client !== "dashboard-agent") {
    return { error: json({ error: "Invalid or missing access token" }, { status: 401 }) };
  }
  return { userId: actor.userId, claims: actor };
}

/** A mismatched claim is the caller's error, the rest are 404s. */
function contextStatus(code: AgentAlertContextError) {
  return code === "environment_mismatch" ? 400 : 404;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const auth = await authenticate(request);
  if ("error" in auth) return auth.error;

  const query = ListQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries())
  );
  if (!query.success) {
    return json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }

  const scope = resolveAgentTokenScope(auth.claims, { environmentId: query.data.environmentId });
  if (!scope.ok) {
    return json({ error: scope.error, code: scope.code }, { status: 400 });
  }

  const context = await resolveAgentAlertContext({
    userId: auth.userId,
    environmentId: scope.environmentId,
    organizationId: scope.organizationId,
    chatId: query.data.chatId,
    claimedEnvironmentId: query.data.environmentId,
    claimedProjectRef: query.data.projectRef,
  });
  if (!context.ok) {
    return json(
      { error: context.error, code: context.code },
      { status: contextStatus(context.code) }
    );
  }

  const channels = await $replica.projectAlertChannel.findMany({
    where: {
      projectId: context.environment.project.id,
      alertTypes: { has: DASHBOARD_AGENT_WATCH_ALERT_TYPE },
    },
    select: { id: true, type: true, enabled: true, properties: true, environmentTypes: true },
    orderBy: { createdAt: "asc" },
  });

  return json({
    alerts: channels.map((channel) => ({
      id: channel.id,
      type: channel.type,
      enabled: channel.enabled,
      environmentTypes: channel.environmentTypes,
      target: describeTarget(channel.type, channel.properties),
    })),
  });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const auth = await authenticate(request);
  if ("error" in auth) return auth.error;
  const { userId } = auth;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }

  const parsed = CreateBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }
  const body = parsed.data;

  const scope = resolveAgentTokenScope(auth.claims, { environmentId: body.environmentId });
  if (!scope.ok) {
    return json({ error: scope.error, code: scope.code }, { status: 400 });
  }

  const context = await resolveAgentAlertContext({
    userId,
    environmentId: scope.environmentId,
    organizationId: scope.organizationId,
    chatId: body.chatId,
    claimedEnvironmentId: body.environmentId,
    claimedProjectRef: body.projectRef,
  });
  if (!context.ok) {
    return json(
      { error: context.error, code: context.code },
      { status: contextStatus(context.code) }
    );
  }
  const { environment } = context;

  const gate = await canUseDashboardAgentEmailAlerts({
    userId,
    organizationId: environment.organizationId,
    organizationSlug: environment.organization.slug,
    projectId: environment.project.id,
  });
  if (!gate.allowed) {
    return json({ error: "Alerts are not available here", code: gate.reason }, { status: 403 });
  }

  // Only the signed-in user's own account email may be subscribed. Read off the
  // primary: this is the identity the subscription is pinned to.
  const user = await prisma.user.findFirst({ where: { id: userId }, select: { email: true } });
  if (!user) {
    return json({ error: "User not found", code: "invalid_request" }, { status: 404 });
  }
  const email = user.email;
  if (body.email && body.email.trim().toLowerCase() !== email.toLowerCase()) {
    return json(
      {
        error:
          "Watch alerts can only go to your own account email. Ask the user to add another address on the Alerts page.",
        code: "email_not_allowed",
      },
      { status: 400 }
    );
  }

  try {
    const channel = await subscribeChannelToWatchAlerts({
      userId,
      email,
      // Stable per (email, project), so asking twice re-enables one channel and asking from
      // a second environment adds that environment to it.
      deduplicationKey: watchAlertDeduplicationKey(email),
      environmentType: environment.type,
      project: environment.project,
    });

    return json({ id: channel.id, type: channel.type, target: email, enabled: channel.enabled });
  } catch (error) {
    // A thrown Response is Remix control flow, not a failure to report.
    if (error instanceof Response) throw error;
    logger.error("Failed to create a dashboard agent watch alert channel", {
      error,
      userId,
      organizationId: environment.organizationId,
      projectId: environment.project.id,
      environmentId: environment.id,
    });
    return json({ error: "Internal Server Error", code: "internal" }, { status: 500 });
  }
}

/** A short, non-secret description of where a channel delivers. */
function describeTarget(type: string, properties: unknown): string | undefined {
  if (type === "EMAIL") {
    const parsed = ProjectAlertEmailProperties.safeParse(properties);
    return parsed.success ? maskEmail(parsed.data.email) : undefined;
  }
  if (type === "SLACK") {
    const parsed = ProjectAlertSlackProperties.safeParse(properties);
    return parsed.success ? `#${parsed.data.channelName}` : undefined;
  }
  // Webhook URLs stay out of the agent's context entirely.
  return undefined;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain || !local) return "an email address";
  const head = local.slice(0, 2);
  return `${head}${local.length > 2 ? "…" : ""}@${domain}`;
}
