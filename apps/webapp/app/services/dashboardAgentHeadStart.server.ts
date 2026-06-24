import { createAnthropic } from "@ai-sdk/anthropic";
import {
  DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
  DASHBOARD_AGENT_MODEL,
  DASHBOARD_AGENT_SYSTEM_PROMPT,
  dashboardAgentCodeToolSchemas,
  dashboardAgentToolSchemas,
} from "@internal/dashboard-agent/tool-schemas";
import { chat as chatServer } from "@trigger.dev/sdk/chat-server";
import { streamText, type UIMessage } from "ai";
import { env } from "~/env.server";
import { dashboardAgentApiOrigin } from "~/services/dashboardAgent.server";
import { logger } from "~/services/logger.server";

const TASK_ID = "dashboard-agent";

const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });

/**
 * Server-owned head start. The webapp generates the chatId and owns the chat
 * record, then kicks off step 1 here via `chat.startHeadStart` (the detached
 * flow): it creates the session (externalId = chatId), triggers the
 * handover-prepare run, and streams step 1 into `session.out` in the background.
 * The browser resumes that stream rather than streaming step 1 inline. Step 1
 * runs the agent's SCHEMA-ONLY tools + the shared model/prompt for the mode the
 * agent run will be in; the agent run picks up tool execution and step 2+.
 *
 * `metadata` (the delegated UAT + context) is merged into the run's wire payload
 * server-side, so it reaches the agent without touching the browser.
 */
export async function startDashboardAgentHeadStart(params: {
  chatId: string;
  messages: UIMessage[];
  mode: "assistant" | "code";
  metadata: Record<string, unknown>;
}): Promise<void> {
  const tools =
    params.mode === "code" ? dashboardAgentCodeToolSchemas : dashboardAgentToolSchemas;
  const system =
    params.mode === "code" ? DASHBOARD_AGENT_CODE_SYSTEM_PROMPT : DASHBOARD_AGENT_SYSTEM_PROMPT;

  const { completion } = await chatServer.startHeadStart({
    agentId: TASK_ID,
    chatId: params.chatId,
    messages: params.messages,
    metadata: params.metadata,
    // Scope session creation + the agent trigger to the agent's project/env. The
    // Anthropic key here only powers the warm step-1 call.
    apiClient: {
      baseURL: dashboardAgentApiOrigin(),
      accessToken: env.DASHBOARD_AGENT_SECRET_KEY,
    },
    run: async ({ chat: helper }) =>
      streamText({
        ...helper.toStreamTextOptions({ tools }),
        model: anthropic(DASHBOARD_AGENT_MODEL),
        system,
      }),
  });

  // The webapp is long-lived, so step 1's drain + the handover dispatch run in
  // the background after this resolves (createSession + trigger have completed).
  // Log a warm-step failure for observability: startHeadStart has already fired
  // handover-skip so the agent run exits cleanly, but the client (mounted as
  // streaming) then resumes an empty session.out, so the turn looks lost.
  completion.catch((error) => {
    logger.error("Dashboard agent head start failed", { chatId: params.chatId, error });
  });
}
