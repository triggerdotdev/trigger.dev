import { TriggerClient } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { env } from "~/env.server";

const TASK_ID = "dashboard-agent";

// The session is created in whatever env DASHBOARD_AGENT_SECRET_KEY belongs to.
// baseURL is the Trigger instance this webapp runs against (its own API origin).
function dashboardAgentConfig() {
  const accessToken = env.DASHBOARD_AGENT_SECRET_KEY;
  if (!accessToken) return null;
  return { baseURL: env.API_ORIGIN ?? env.APP_ORIGIN, accessToken };
}

export function isDashboardAgentConfigured(): boolean {
  return Boolean(env.DASHBOARD_AGENT_SECRET_KEY);
}

export async function startDashboardAgentSession(params: {
  chatId: string;
  clientData?: Record<string, unknown>;
}): Promise<{ publicAccessToken: string }> {
  const config = dashboardAgentConfig();
  if (!config) throw new Error("DASHBOARD_AGENT_SECRET_KEY is not set");
  const startSession = chat.createStartSessionAction(TASK_ID, { apiClient: config });
  return startSession({ chatId: params.chatId, clientData: params.clientData });
}

export async function mintDashboardAgentToken(chatId: string): Promise<string> {
  const config = dashboardAgentConfig();
  if (!config) throw new Error("DASHBOARD_AGENT_SECRET_KEY is not set");
  const client = new TriggerClient(config);
  return client.auth.createPublicToken({
    scopes: { read: { sessions: chatId }, write: { sessions: chatId } },
    expirationTime: "1h",
  });
}
