import { chat } from "@trigger.dev/sdk/ai";
import { locals, logger, tasks } from "@trigger.dev/sdk";
import {
  generateText,
  stepCountIs,
  streamText,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai";
import {
  orgAllowsTurnEvals,
  redactEvalToolValue,
  shouldEvalTurn,
  turnReadSource,
} from "./eval-policy";
import type { EvalTurnPayload, evalTurn } from "./eval-turn";
import {
  buildTurnTools,
  clientDataSchema,
  dashboardAgentModelKey,
  getStore,
  getSystemPrompt,
  modeFor,
  registry,
  sanitizeReplayedToolInputs,
  settleOpenInvestigations,
  type DashboardAgentStore,
} from "./agent-runtime";
import { titlePrompt } from "./prompts";
import {
  describePromptPrefix,
  PROMPT_CACHE_CONTROL,
  promptCacheAttributes,
  type PromptCacheUsage,
} from "./prompt-prefix";
import { dashboardAgentActionSchema, handleWatchAction } from "./watch-actions";
import { dashboardAgentCompaction, withDurableState } from "./compaction";

// The runtime and the watch lanes live in their own modules; re-exported here so
// every existing import path still resolves.
export {
  clientDataSchema,
  dashboardAgentModelKey,
  dashboardAgentStoreKey,
  dashboardAgentToolsKey,
  sanitizeReplayedToolInputs,
  type DashboardAgentStore,
} from "./agent-runtime";
// The eval's data-handling policy lives in `eval-policy.ts`; re-exported so every
// existing import path still resolves.
export {
  DEFAULT_CI_EVAL_SAMPLE_RATE,
  DEFAULT_EVAL_SAMPLE_RATE,
  evalSampleRate,
  isCiEvalContext,
  orgAllowsTurnEvals,
  redactEvalToolValue,
  shouldEvalTurn,
  turnReadSource,
} from "./eval-policy";
export {
  dashboardAgentActionSchema,
  wakeStartsInvestigation,
  watchInvestigateActionSchema,
  watchWakeActionSchema,
  type DashboardAgentAction,
  type WatchInvestigateAction,
  type WatchWakeAction,
} from "./watch-actions";

/**
 * The in-dashboard agent, built on chat.agent and deployed as an internal task
 * by the webapp.
 *
 * Persistence goes to the agent's own datastore, never the main DB — the agent
 * has no access to that. chat.agent owns the runtime history snapshot; the rows
 * written here are the display read-model the dashboard renders from.
 */

/**
 * The chat's owner, remembered per run. The id-deduped append is scoped to the
 * user, and the error path's `onTurnComplete` gets no parsed `clientData` —
 * parsing it may be what failed.
 */
const chatOwners = new Map<string, string>();

/**
 * What a failed turn leaves in the transcript. Fixed wording: the provider's error
 * string is not something to show a user, and this is persisted forever.
 */
export const TURN_FAILED_MESSAGE =
  "Something went wrong on my side, so that turn didn't finish. Ask again and I'll pick it up.";

/** Stable per turn, so a re-run of the error path can't stack two records. */
export function turnFailureMessageId(turn: number): string {
  return `turn-error:${turn}`;
}

/**
 * Set when this turn's stream errored. A mid-stream failure is converted to an
 * error chunk rather than thrown, so `onTurnComplete` sees no `error` and no
 * `finishReason` — the stream's own error hook is the only place it is visible.
 * Reset every turn in `onTurnStart`.
 */
const turnErroredKey = locals.create<boolean>("dashboard-agent.turnErrored");

function turnFailureMessage(turn: number): UIMessage {
  return {
    id: turnFailureMessageId(turn),
    role: "assistant",
    parts: [{ type: "text", text: TURN_FAILED_MESSAGE }],
  };
}

// How the per-turn eval is enqueued. Unset in production; tests inject a
// recorder to observe whether a turn was sampled.
export type DashboardAgentEvalTrigger = (
  payload: EvalTurnPayload,
  options: { idempotencyKey: string }
) => Promise<unknown>;

export const dashboardAgentEvalTriggerKey = locals.create<DashboardAgentEvalTrigger>(
  "dashboard-agent.eval-trigger"
);

/**
 * The org opt-out check. Unset in production; tests inject one so no turn depends on a
 * network call.
 */
export type DashboardAgentEvalPolicyCheck = (params: {
  apiOrigin?: string;
  userActorToken?: string;
  organizationId: string;
}) => Promise<boolean>;

export const dashboardAgentEvalPolicyKey = locals.create<DashboardAgentEvalPolicyCheck>(
  "dashboard-agent.eval-policy"
);

function getEvalPolicyCheck(): DashboardAgentEvalPolicyCheck {
  return locals.get(dashboardAgentEvalPolicyKey) ?? orgAllowsTurnEvals;
}

function getEvalTrigger(): DashboardAgentEvalTrigger {
  return (
    locals.get(dashboardAgentEvalTriggerKey) ??
    ((payload, options) =>
      tasks.trigger<typeof evalTurn>("dashboard-agent-eval-turn", payload, options))
  );
}

function extractText(message: UIMessage): string {
  return (message.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim();
}

/**
 * Cap on each tool output in the eval payload. The judge only has to check the
 * answer against the result, which a prefix supports — a run trace or a file read
 * is tens of thousands of characters of it.
 */
export const MAX_EVAL_TOOL_OUTPUT_CHARS = 1500;

/** Marks the prefix as a prefix, so the judge doesn't read a cut result as the whole one. */
export function truncateEvalToolOutput(output: unknown): unknown {
  if (output === undefined) return output;
  const serialized = JSON.stringify(output);
  if (serialized === undefined || serialized.length <= MAX_EVAL_TOOL_OUTPUT_CHARS) return output;
  return {
    truncated: true,
    outputPrefix: serialized.slice(0, MAX_EVAL_TOOL_OUTPUT_CHARS),
    note: `[truncated: the first ${MAX_EVAL_TOOL_OUTPUT_CHARS} of ${serialized.length} characters of this tool's output]`,
  };
}

// Pair this turn's tool-calls with their results — the ground truth the eval
// judge checks the answer against. Redacted first, then capped: the customer's own
// data (payloads, outputs, query rows, file contents) never leaves as itself.
export function extractToolActivity(
  messages: ModelMessage[]
): Array<{ toolName: string; input?: unknown; output?: unknown }> {
  const byId = new Map<string, { toolName: string; input?: unknown; output?: unknown }>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{
      type: string;
      toolCallId?: string;
      toolName?: string;
      input?: unknown;
      output?: unknown;
    }>) {
      if (part.type === "tool-call" && part.toolCallId) {
        byId.set(part.toolCallId, {
          toolName: String(part.toolName ?? ""),
          input: redactEvalToolValue(part.input),
        });
      } else if (part.type === "tool-result" && part.toolCallId) {
        const existing = byId.get(part.toolCallId);
        if (existing) existing.output = truncateEvalToolOutput(redactEvalToolValue(part.output));
      }
    }
  }
  return [...byId.values()];
}

function cleanTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80)
    .trim();
}

/**
 * Title generation in flight, per chat. Started in `onTurnStart` and awaited in
 * `onBeforeTurnComplete`, while the stream is still open. The panel reloads its
 * chat list once, when the turn settles, so the name must be on the row by then
 * or the list reads "New chat".
 */
const pendingTitles = new Map<string, Promise<void>>();

async function generateAndSaveTitle(
  store: DashboardAgentStore,
  chatId: string,
  uiMessages: UIMessage[]
): Promise<void> {
  const firstUserMessage = uiMessages.find((message) => message.role === "user");
  const userText = firstUserMessage ? extractText(firstUserMessage) : "";
  if (!userText) return;

  const resolved = await titlePrompt.resolve({});
  const { text } = await generateText({
    model:
      locals.get(dashboardAgentModelKey) ??
      registry.languageModel(
        (resolved.model ?? "anthropic:claude-haiku-4-5") as `anthropic:${string}`
      ),
    system: resolved.text,
    prompt: userText,
    ...resolved.toAISDKTelemetry(),
  });

  const title = cleanTitle(text);
  if (title) {
    await store.setChatTitleIfDefault({ chatId, title });
  }
}

export type {
  AgentPage,
  AgentPageContext,
  AgentPageSignal,
} from "@internal/dashboard-agent-contracts";

/**
 * One line per model call: what the provider billed as a cache write, a cache read
 * and uncached input, against the prefix we expect to be cached. The estimate and
 * the fingerprint are ours; the token counts are the provider's, and are logged as
 * `null` when it reported none.
 */
function recordPromptCacheUsage(args: {
  source: string;
  usage: PromptCacheUsage | undefined;
  system: string;
  tools: ToolSet;
}): void {
  try {
    logger.info(
      "dashboard-agent prompt cache",
      promptCacheAttributes({
        source: args.source,
        usage: args.usage,
        prefix: describePromptPrefix({ system: args.system, tools: args.tools }),
      })
    );
  } catch (error) {
    // Measurement must never fail a turn.
    logger.debug("dashboard-agent prompt cache measurement failed", { error });
  }
}

export const dashboardAgent = chat.agent({
  id: "dashboard-agent",
  clientDataSchema,
  // Actions are not turns — see `narrateWatchWake`.
  actionSchema: dashboardAgentActionSchema,
  // Short idle window so suspended runs release their DB pool.
  idleTimeoutInSeconds: 60,

  uiMessageStreamOptions: {
    // The stream carries the same sentence the transcript keeps, so the live chunk
    // and the stored record never disagree. The provider's own message is logged
    // here and goes no further.
    onError: (error) => {
      locals.set(turnErroredKey, true);
      logger.error("dashboard-agent turn failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return TURN_FAILED_MESSAGE;
    },
  },

  // Read-only tools, rebuilt per turn from the delegated token the `in` proxy
  // injects. Declared here rather than only inside run so the SDK re-applies each
  // tool's output conversion when it replays prior-turn history. The
  // `investigations` capability is the one seam from the tool lane to the agent's
  // datastore, wired here (where the chat id is known) so `tools.ts` stays free of
  // the database package.
  tools: async ({ chatId, clientData }) => buildTurnTools(chatId, clientData),

  onBoot: async () => {
    // Establish the store, and in production its connection pool, once.
    getStore();
  },

  onChatStart: async ({ chatId, clientData }) => {
    chatOwners.set(chatId, clientData.userId);
    await getStore().ensureChat({
      id: chatId,
      organizationId: clientData.organizationId,
      userId: clientData.userId,
      metadata: {
        context: {
          projectId: clientData.projectId,
          environmentId: clientData.environmentId,
          currentPage: clientData.currentPage,
        },
      },
    });
  },

  // Every action is a watch action, handled in `watch-actions.ts`: one message
  // deduped on the action id, piped inside so it reaches the history and read-model.
  onAction: async ({ action, chatId, clientData, uiMessages, messages }) =>
    handleWatchAction({ action, chatId, clientData, uiMessages, messages }),

  onTurnStart: async ({ chatId, uiMessages, clientData }) => {
    // Set every turn, not only on chat start: a continuation run skips onChatStart.
    if (clientData?.userId) chatOwners.set(chatId, clientData.userId);
    locals.set(turnErroredKey, false);

    // Awaited, never chat.defer: a mid-stream refresh must not read an empty
    // transcript.
    await getStore().persistMessages({ chatId, messages: uiMessages });

    // Name the chat on the first exchange, started here so it runs while the model
    // answers. Awaited in `onBeforeTurnComplete`, not here; a failure only costs the
    // generated name. The gate is the transcript length at the START of the turn,
    // where one message means nothing has been answered yet.
    if (uiMessages.length <= 1 && !pendingTitles.has(chatId)) {
      const store = getStore();
      pendingTitles.set(
        chatId,
        generateAndSaveTitle(store, chatId, uiMessages).catch((error) => {
          logger.error("Failed to generate a dashboard-agent chat title", { chatId, error });
        })
      );
    }

    // Set every turn so continuation runs (which skip onChatStart) still get the
    // prompt; the resolve is cached per process. The cache breakpoint on the system
    // block carries through toStreamTextOptions() and survives suspend/resume.
    chat.prompt.set(await getSystemPrompt(modeFor(clientData)), {
      providerOptions: { anthropic: { cacheControl: PROMPT_CACHE_CONTROL } },
    });
  },

  // The last point at which a write still lands ahead of the client's settle:
  // `onTurnComplete` runs after the frontend stream closes. That is why the title
  // is awaited here.
  onBeforeTurnComplete: async ({ chatId }) => {
    const pending = pendingTitles.get(chatId);
    if (!pending) return;
    pendingTitles.delete(chatId);
    await pending;
  },

  onTurnComplete: async ({
    chatId,
    turn,
    uiMessages,
    newMessages,
    responseMessage,
    clientData,
    chatAccessToken,
    lastEventId,
    runId,
    finishReason,
    error,
  }) => {
    const store = getStore();

    // Settle before anything else: the run is over, so a card left `in_progress`
    // never settles on its own and a refresh right after the turn would read a
    // spinner that never stops.
    await settleOpenInvestigations(store, chatId);

    // A turn that ended in an error is part of the conversation, not only a stream
    // event: the browser rendered the error chunk but nothing recorded it, so
    // reloading showed a turn that just stops.
    const errored =
      error !== undefined || finishReason === "error" || locals.get(turnErroredKey) === true;
    const failure = errored ? turnFailureMessage(turn) : undefined;
    // Into the accumulator too, so the next turn's wholesale write keeps it.
    if (failure) chat.history.set([...uiMessages, failure]);

    // Transcript and session state in one transaction, so the next page load reads
    // both consistently.
    await store.persistTurn({
      chatId,
      messages: uiMessages,
      session: {
        publicAccessToken: chatAccessToken,
        lastEventId,
        runId,
      },
    });

    // After the transcript write, and id-deduped, so a retried error path appends
    // the record once rather than a second copy.
    if (failure) {
      const userId = clientData?.userId ?? chatOwners.get(chatId);
      if (userId) {
        await store.appendMessage({ chatId, userId, message: failure });
      } else {
        logger.error("dashboard-agent failed turn has no userId; skipping the append", { chatId });
      }
    }

    // Score this turn in a separate, idempotency-keyed task so it never blocks or
    // bills the agent run. Best-effort: an enqueue failure must not break the turn.
    if (clientData?.organizationId && clientData?.userId && responseMessage && shouldEvalTurn()) {
      try {
        const toolActivity = extractToolActivity(newMessages);
        // A turn that read source is never judged at all: judging it either hands the
        // customer's code to the judge or grades a source-grounded answer blind.
        if (turnReadSource(toolActivity)) {
          logger.debug("dashboard-agent turn eval skipped: the turn read source", { chatId, turn });
        } else if (
          // Fails closed: an org that opted out, or a setting we couldn't read, is not judged.
          !(await getEvalPolicyCheck()({
            apiOrigin: clientData.apiOrigin,
            userActorToken: clientData.userActorToken,
            organizationId: clientData.organizationId,
          }))
        ) {
          logger.debug("dashboard-agent turn eval skipped: the org doesn't allow it", { chatId });
        } else {
          const resolved = await getSystemPrompt(modeFor(clientData));
          // On a Head Start turn the question arrives in the boot payload rather than
          // newUIMessages, so read the latest user message from the full transcript.
          const userMessage = [...uiMessages].reverse().find((m) => m.role === "user");
          await getEvalTrigger()(
            {
              chatId,
              turn,
              agentRunId: runId,
              organizationId: clientData.organizationId,
              userId: clientData.userId,
              projectRef: clientData.projectRef,
              environment: clientData.environmentName,
              currentPage: clientData.currentPage,
              model: resolved.model,
              promptSlug: resolved.promptId,
              promptVersion: resolved.version,
              userText: userMessage ? extractText(userMessage) : "",
              assistantText: extractText(responseMessage),
              toolActivity,
            } satisfies EvalTurnPayload,
            { idempotencyKey: `eval:${chatId}:${turn}` }
          );
        }
      } catch (error) {
        logger.error("Failed to enqueue dashboard-agent turn eval", { error });
      }
    }
  },

  // Summarise the older conversation once it outgrows the budget. UI messages are
  // untouched, so the transcript the user reads never loses anything.
  compaction: dashboardAgentCompaction,

  // Roll a cache breakpoint onto the last message every turn so the growing
  // conversation prefix is cached and read back cheaply. Composes with the
  // system-block breakpoint above. chat.agent keeps the Head Start handover's
  // tool-approval tail intact across this hook, so it is safe on a resume turn.
  prepareMessages: ({ messages, reason }) => {
    if (messages.length === 0) return messages;
    // The between-steps compaction path rebuilds history as the summary alone and
    // never reaches `compactModelMessages`, so the live investigation and watch state
    // is pinned back here instead.
    const sanitized = sanitizeReplayedToolInputs(
      reason === "run" ? messages : withDurableState(messages, chat.history.all())
    );

    const last = sanitized[sanitized.length - 1];
    return [
      ...sanitized.slice(0, -1),
      {
        ...last,
        providerOptions: {
          ...last.providerOptions,
          anthropic: { cacheControl: PROMPT_CACHE_CONTROL },
        },
      },
    ];
  },

  // System prompt and model come from the managed prompt set in onTurnStart, so
  // they are dashboard-editable. toStreamTextOptions() supplies the system text
  // with its cache breakpoint, config, telemetry and prepareStep wiring; the model
  // string is resolved through the registry here so streamText keeps a typed model.
  run: async ({ messages, signal, tools }) => {
    const resolved = chat.prompt();
    return streamText({
      ...chat.toStreamTextOptions({ tools }),
      model:
        locals.get(dashboardAgentModelKey) ??
        registry.languageModel(
          (resolved.model ?? "anthropic:claude-sonnet-4-6") as `anthropic:${string}`
        ),
      messages,
      abortSignal: signal,
      // Per model call, so the head-start prefix and this one can be compared.
      onStepFinish: (step) =>
        recordPromptCacheUsage({
          source: "agent-turn",
          usage: step.usage,
          system: resolved.text,
          tools: tools ?? {},
        }),
      // toStreamTextOptions() defaults to a single step; override so the model can
      // call a tool and then answer from its result in the same turn.
      stopWhen: stepCountIs(10),
    });
  },
});
