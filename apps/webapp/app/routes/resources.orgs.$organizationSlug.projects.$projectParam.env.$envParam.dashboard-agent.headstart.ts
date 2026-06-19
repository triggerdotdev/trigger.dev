import { createAnthropic } from "@ai-sdk/anthropic";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  DASHBOARD_AGENT_MODEL,
  DASHBOARD_AGENT_SYSTEM_PROMPT,
  dashboardAgentToolSchemas,
} from "@internal/dashboard-agent/tool-schemas";
import { chat as chatServer } from "@trigger.dev/sdk/chat-server";
import { streamText } from "ai";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { findProjectBySlug } from "~/models/project.server";
import {
  dashboardAgentApiOrigin,
  isDashboardAgentConfigured,
  mintDashboardAgentUserActorToken,
} from "~/services/dashboardAgent.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";

// Head Start: the transport POSTs the first turn of a brand-new chat here so
// step 1's LLM call streams from this warm server while the agent run boots in
// parallel. We run step 1 with the agent's SCHEMA-ONLY tools (no `execute`, so
// the data-lane code never enters this bundle) + the shared default model and
// prompt. The agent run picks up tool execution and step 2+.
//
// The token never touches the browser: same as the `in` proxy, we mint a fresh
// read-only UAT and inject it into the wire payload's `metadata` before the
// handler parses it. That metadata becomes the durable handover-prepare run's
// payload, so the first turn's tool calls (which execute in the agent run) are
// authed as the user. `apiClient` scopes session creation to the agent's
// project; the Anthropic key here only powers the warm step-1 call.

const ENV_NAME_BY_TYPE: Record<string, string> = {
  DEVELOPMENT: "dev",
  STAGING: "staging",
  PRODUCTION: "prod",
  PREVIEW: "preview",
};

const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });

const headStartHandler = chatServer.headStart({
  agentId: "dashboard-agent",
  apiClient: {
    baseURL: dashboardAgentApiOrigin(),
    accessToken: env.DASHBOARD_AGENT_SECRET_KEY,
  },
  run: async ({ chat: helper }) =>
    streamText({
      ...helper.toStreamTextOptions({ tools: dashboardAgentToolSchemas }),
      model: anthropic(DASHBOARD_AGENT_MODEL),
      system: DASHBOARD_AGENT_SYSTEM_PROMPT,
    }),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  if (
    !(await canAccessDashboardAgent({
      userId: user.id,
      isAdmin: user.admin,
      isImpersonating: user.isImpersonating,
      organizationSlug,
    }))
  ) {
    return json({ error: "Not found" }, { status: 404 });
  }

  if (!isDashboardAgentConfigured() || !env.ANTHROPIC_API_KEY) {
    return json({ error: "The dashboard agent is not configured." }, { status: 501 });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) return json({ error: "Project not found" }, { status: 404 });

  const runtimeEnv = await $replica.runtimeEnvironment.findFirst({
    where: { projectId: project.id, slug: envParam },
    select: { type: true },
  });
  const environmentName = runtimeEnv ? ENV_NAME_BY_TYPE[runtimeEnv.type] : undefined;

  // Inject the delegated token + context into the wire payload's metadata,
  // which becomes the handover-prepare run's payload (server-side, never the
  // browser). The head-start body is the flat wire payload with a top-level
  // `metadata` field.
  const raw = await request.text();
  let forwarded = request;
  try {
    const body = JSON.parse(raw) as { metadata?: Record<string, unknown> };
    body.metadata = {
      ...(body.metadata ?? {}),
      userActorToken: await mintDashboardAgentUserActorToken(user.id),
      apiOrigin: dashboardAgentApiOrigin(),
      projectRef: project.externalRef,
      environmentName,
    };
    forwarded = new Request(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(body),
    });
  } catch {
    // Non-JSON or unexpected shape — forward unchanged rather than break the turn.
  }

  try {
    return await headStartHandler(forwarded);
  } catch (error) {
    logger.error("Dashboard agent head-start failed", { error });
    return json({ error: "The dashboard agent couldn't start." }, { status: 502 });
  }
}
