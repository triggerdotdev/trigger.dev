import { createAnthropic } from "@ai-sdk/anthropic";
import {
  DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
  DASHBOARD_AGENT_MODEL,
  DASHBOARD_AGENT_SYSTEM_PROMPT,
  dashboardAgentCodeToolSchemas,
  dashboardAgentToolSchemas,
} from "@internal/dashboard-agent/tool-schemas";
import { ApiClient, SessionStreamInstance, writeTurnCompleteRecord } from "@trigger.dev/core/v3";
import { chat as chatServer } from "@trigger.dev/sdk/chat-server";
import { streamText, type UIMessage, type UIMessageChunk } from "ai";
import { env } from "~/env.server";
import {
  dashboardAgentApiOrigin,
  dashboardAgentTriggerConfig,
} from "~/services/dashboardAgent.server";
import { logger } from "~/services/logger.server";

const TASK_ID = "dashboard-agent";

const anthropic = createAnthropic({ apiKey: env.ANTHROPIC_API_KEY });

/**
 * Shown in the chat when the warm first turn never produced anything. Generic on
 * purpose — the underlying provider/network error is logged, not surfaced. The
 * user can just send the message again.
 */
export const HEAD_START_FAILURE_ERROR_TEXT =
  "The assistant couldn't start this response. Please send your message again.";

/**
 * The two writes the failure path needs on `session.out`. Split out as a seam so
 * the failure logic is unit-testable without S2 credentials or a live session.
 */
export type DashboardAgentSessionOutWriter = {
  /** Append one UIMessage chunk as a data record. */
  writeChunk(chunk: UIMessageChunk): Promise<void>;
  /** Append the `turn-complete` control record that closes the client's stream. */
  writeTurnComplete(): Promise<void>;
};

/**
 * Surface a failed warm step 1 to the client as a visible error turn.
 *
 * `startHeadStart` has already dispatched `handover-skip`, so the agent run
 * exits without writing anything — nobody else will ever write to `session.out`
 * for this turn. The browser, which mounts as streaming and resumes
 * `session.out`, would otherwise hang on an empty stream and the turn would look
 * silently lost.
 *
 * The shape mirrors what the chat.agent runtime emits on a failed turn (see
 * `packages/trigger-sdk/src/v3/chat.ts`): an `{ type: "error", errorText }` data
 * chunk — which the AI SDK transport turns into `useChat`'s `error`, rendered by
 * DashboardAgentMessages — followed by the `turn-complete` control record, which
 * is what actually closes the resumed stream (see `chat-client.ts`).
 *
 * `turn-complete` is written even if the error chunk fails, so a resumed stream
 * always terminates; the chunk's error still propagates to the caller for logging.
 */
export async function writeHeadStartFailureToSessionOut(
  writer: DashboardAgentSessionOutWriter
): Promise<void> {
  try {
    await writer.writeChunk({
      type: "error",
      errorText: HEAD_START_FAILURE_ERROR_TEXT,
    } as UIMessageChunk);
  } finally {
    await writer.writeTurnComplete();
  }
}

function singleChunkStream(chunk: UIMessageChunk): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      controller.enqueue(chunk);
      controller.close();
    },
  });
}

// Writes as the agent's own environment (secret key auth) — `.out` appends are
// PRIVATE-only, and this is the same credential the head start creates the
// session with.
function createSessionOutWriter(
  chatId: string,
  accessToken: string
): DashboardAgentSessionOutWriter {
  const apiClient = new ApiClient(dashboardAgentApiOrigin(), accessToken);
  return {
    async writeChunk(chunk) {
      const instance = new SessionStreamInstance<UIMessageChunk>({
        apiClient,
        baseUrl: apiClient.baseUrl,
        sessionId: chatId, // Sessions are addressable by externalId (chatId).
        io: "out",
        source: singleChunkStream(chunk),
      });
      await instance.wait();
    },
    async writeTurnComplete() {
      await writeTurnCompleteRecord(apiClient, chatId);
    },
  };
}

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
  const tools = params.mode === "code" ? dashboardAgentCodeToolSchemas : dashboardAgentToolSchemas;
  const system =
    params.mode === "code" ? DASHBOARD_AGENT_CODE_SYSTEM_PROMPT : DASHBOARD_AGENT_SYSTEM_PROMPT;

  const { completion } = await chatServer.startHeadStart({
    agentId: TASK_ID,
    chatId: params.chatId,
    messages: params.messages,
    metadata: params.metadata,
    triggerConfig: dashboardAgentTriggerConfig(),
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
  // On failure startHeadStart has already fired handover-skip, so the agent run
  // exits cleanly and nothing else will ever write to session.out for this turn —
  // write an error turn ourselves so the client's resume shows a visible,
  // retryable error instead of an empty chat.
  completion.catch(async (error) => {
    logger.error("Dashboard agent head start failed", { chatId: params.chatId, error });

    const accessToken = env.DASHBOARD_AGENT_SECRET_KEY;
    if (!accessToken) return;

    try {
      await writeHeadStartFailureToSessionOut(createSessionOutWriter(params.chatId, accessToken));
    } catch (writeError) {
      logger.error("Failed to write dashboard agent head start error to session.out", {
        chatId: params.chatId,
        error: writeError,
      });
    }
  });
}
