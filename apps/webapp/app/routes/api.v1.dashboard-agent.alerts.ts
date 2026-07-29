import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import {
  ProjectAlertEmailProperties,
  ProjectAlertSlackProperties,
} from "~/models/projectAlert.server";
import { resolveAgentAlertContext } from "~/services/dashboardAgentAlertContext.server";
import {
  canUseDashboardAgentEmailAlerts,
  DASHBOARD_AGENT_WATCH_ALERT_TYPE,
} from "~/services/dashboardAgentWatchAlerts.server";
import { logger } from "~/services/logger.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";
import { CreateAlertChannelService } from "~/v3/services/alerts/createAlertChannel.server";

/**
 * `GET /api/v1/dashboard-agent/alerts` — what alerts this chat's project sends
 * when a watch fires.
 * `POST /api/v1/dashboard-agent/alerts` — subscribe the user's email to them.
 *
 * Accepts ONLY the dashboard agent's delegated user-actor token, like the watches
 * endpoint: POST creates something that later mails a person, so the only caller
 * it trusts is the agent acting for the signed-in user in a live chat.
 *
 * The plan/flag gate is enforced here AND at delivery, and its denial carries a
 * machine-readable `reason` so the agent can say why instead of guessing.
 */

const ListQuerySchema = z.object({
  chatId: z.string().min(1),
  environmentId: z.string().min(1).optional(),
  projectRef: z.string().min(1).optional(),
});

const CreateBodySchema = z.object({
  chatId: z.string().min(1),
  channel: z.literal("email"),
  /** Defaults to the authenticated user's account email. */
  email: z.string().email().optional(),
  environmentId: z.string().min(1).optional(),
  projectRef: z.string().min(1).optional(),
});

async function authenticate(request: Request) {
  const authentication = await authenticateUatOrApiRequest(request);
  if (!authentication?.userActor) return undefined;
  if (authentication.userActor.client !== "dashboard-agent") return undefined;
  return authentication.userActor.userId;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await authenticate(request);
  if (!userId) {
    return json({ error: "Invalid or missing access token" }, { status: 401 });
  }

  const query = ListQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries())
  );
  if (!query.success) {
    return json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }

  const context = await resolveAgentAlertContext({ userId, ...query.data });
  if (!context.ok) {
    return json({ error: context.error, code: context.code }, { status: 404 });
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

  const userId = await authenticate(request);
  if (!userId) {
    return json({ error: "Invalid or missing access token" }, { status: 401 });
  }

  let body: z.infer<typeof CreateBodySchema>;
  try {
    const parsed = CreateBodySchema.safeParse(await request.json());
    if (!parsed.success) {
      return json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return json({ error: "Invalid request", code: "invalid_request" }, { status: 400 });
  }

  const context = await resolveAgentAlertContext({
    userId,
    chatId: body.chatId,
    environmentId: body.environmentId,
    projectRef: body.projectRef,
  });
  if (!context.ok) {
    return json({ error: context.error, code: context.code }, { status: 404 });
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

  // Default to the account email: the agent must not be able to point an alert at
  // an address the user didn't give it.
  let email = body.email;
  if (!email) {
    const user = await $replica.user.findFirst({ where: { id: userId }, select: { email: true } });
    if (!user) {
      return json({ error: "User not found", code: "invalid_request" }, { status: 404 });
    }
    email = user.email;
  }

  try {
    const service = new CreateAlertChannelService();
    const channel = await service.call(environment.project.externalRef, userId, {
      name: `Watch alerts for ${email}`,
      alertTypes: [DASHBOARD_AGENT_WATCH_ALERT_TYPE],
      environmentTypes: [environment.type],
      // Stable per (email, project): asking twice re-enables the existing
      // subscription instead of stacking duplicate channels.
      deduplicationKey: `dashboard-agent-watch:${email}`,
      channel: { type: "EMAIL", email },
    });

    return json({ id: channel.id, type: channel.type, target: email, enabled: channel.enabled });
  } catch (error) {
    logger.error("Failed to create a dashboard agent watch alert channel", { error });
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
