import { signUserActorToken } from "@trigger.dev/rbac";
import { TriggerClient } from "@trigger.dev/sdk";
import { chat } from "@trigger.dev/sdk/ai";
import { env } from "~/env.server";

const TASK_ID = "dashboard-agent";

// Read-only cap on the agent's delegated user-actor token. `read:apiKeys` is
// what lets it exchange the token for an env JWT (the gate on the exchange
// route); the rest scope the actual reads. No write/admin scopes, so even a
// leaked token can't mutate anything.
const DASHBOARD_AGENT_UAT_CAP = [
  "read:apiKeys",
  "read:runs",
  "read:deployments",
  "read:environments",
];

// Minted fresh on every turn (the `in` proxy injects it), so the lifetime only
// has to cover a single turn's tool calls. Short by design — a stale token in
// the agent's run payload expires quickly.
const DASHBOARD_AGENT_UAT_TTL_SECONDS = 10 * 60;

// The Trigger instance this webapp runs against — the same origin the agent
// task calls back to (as the user) for its read tools.
export function dashboardAgentApiOrigin(): string {
  return env.API_ORIGIN ?? env.APP_ORIGIN;
}

// Mint a short-lived, read-only delegated token for the signed-in user. Self
// service from the dashboard session (never a PAT), so a user can only ever
// mint a token for themselves. The `in` proxy injects this into the turn's
// metadata so the token reaches the agent without ever touching the browser.
export function mintDashboardAgentUserActorToken(userId: string): Promise<string> {
  return signUserActorToken(env.SESSION_SECRET, {
    userId,
    client: "dashboard-agent",
    cap: DASHBOARD_AGENT_UAT_CAP,
    expirationTime: Math.floor(Date.now() / 1000) + DASHBOARD_AGENT_UAT_TTL_SECONDS,
  });
}

// The session is created in whatever env DASHBOARD_AGENT_SECRET_KEY belongs to.
// baseURL is the Trigger instance this webapp runs against (its own API origin).
function dashboardAgentConfig() {
  const accessToken = env.DASHBOARD_AGENT_SECRET_KEY;
  if (!accessToken) return null;
  return { baseURL: dashboardAgentApiOrigin(), accessToken };
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
