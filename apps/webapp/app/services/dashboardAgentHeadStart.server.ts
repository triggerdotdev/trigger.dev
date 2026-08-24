import {
  DASHBOARD_AGENT_CODE_SYSTEM_PROMPT,
  DASHBOARD_AGENT_MODEL,
  DASHBOARD_AGENT_SYSTEM_PROMPT,
  dashboardAgentCodeToolSchemas,
  dashboardAgentToolSchemas,
} from "@internal/dashboard-agent/tool-schemas";
import {
  describePromptPrefix,
  promptCacheAttributes,
} from "@internal/dashboard-agent/prompt-prefix";
import {
  resolveDashboardAgentModel,
  withCacheBreakpoint,
} from "@internal/dashboard-agent/model-provider";
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

/** Shown when the warm first turn produced nothing. The provider error is only logged. */
export const HEAD_START_FAILURE_ERROR_TEXT =
  "The assistant couldn't start this response. Please send your message again.";

/** A seam so the failure path is testable without S2 credentials or a live session. */
export type DashboardAgentSessionOutWriter = {
  writeChunk(chunk: UIMessageChunk): Promise<void>;
  /** The `turn-complete` control record that closes the client's stream. */
  writeTurnComplete(): Promise<void>;
};

/**
 * Surface a failed warm step 1 as a visible error turn. `turn-complete` is written even if
 * the error chunk fails, so a resumed stream always terminates.
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

// Writes as the agent's own environment: `.out` appends are private-only.
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
 * Server-owned head start: creates the session, triggers the handover-prepare run, and
 * streams step 1 into `session.out`. `metadata` is merged into the run's payload server-side.
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
    // Scopes session creation and the agent trigger to the agent's own environment.
    apiClient: {
      baseURL: dashboardAgentApiOrigin(),
      accessToken: env.DASHBOARD_AGENT_SECRET_KEY,
    },
    run: async ({ chat: helper }) =>
      streamText({
        ...helper.toStreamTextOptions({ tools }),
        model: resolveDashboardAgentModel(DASHBOARD_AGENT_MODEL),
        // A structured system message, not a bare string: without provider options
        // the provider neither writes nor reads the cache, so this call paid full price
        // for the prefix and the agent's step 2 then paid for a fresh write. The tool
        // key order is frozen (see `tool-schemas.ts`) so both prefixes are identical
        // — the logged fingerprint is how a drift becomes visible.
        system: {
          role: "system",
          content: system,
          providerOptions: withCacheBreakpoint(undefined, "prefix"),
        },
        onStepFinish: (step) => {
          logger.info(
            "Dashboard agent prompt cache",
            promptCacheAttributes({
              source: "head-start",
              usage: step.usage,
              prefix: describePromptPrefix({ system, tools }),
            })
          );
        },
      }),
  });

  // Step 1's drain and the handover dispatch continue in the background. On failure
  // `startHeadStart` already fired handover-skip, so nothing else writes to session.out.
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
