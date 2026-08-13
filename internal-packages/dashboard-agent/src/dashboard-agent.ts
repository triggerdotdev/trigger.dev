import { isWatchRequestMessageId, sliceWellFormed } from "@internal/dashboard-agent-contracts";
import { chat } from "@trigger.dev/sdk/ai";
import { locals, logger, tasks } from "@trigger.dev/sdk";
import { generateText, stepCountIs, streamText, type ModelMessage, type UIMessage } from "ai";
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
  resolveDashboardAgentModel,
  sanitizeReplayedToolInputs,
  settlementCardMessages,
  clearOpenInvestigations,
  pendingInvestigationSettlements,
  withCacheBreakpointOnLast,
  type DashboardAgentStore,
} from "./agent-runtime";
import { titlePrompt } from "./prompts";
import { withCacheBreakpoint } from "./model-provider";
import { recordPromptCacheUsage, stepCachePrepareStep } from "./step-cache";
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
// The rolling step cache lives in `step-cache.ts`, shared with the watch lane;
// re-exported so every existing import path still resolves.
export {
  markStepCacheBreakpoint,
  MIN_STEP_CACHE_CHARS,
  stepCacheAttributes,
  STEP_CACHE_CONTROL,
  withStepCacheBreakpoint,
} from "./step-cache";
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

/**
 * Append-only by message id. Both the terminal settlement cards and the failure
 * record carry stable ids, so a retried turn writes the same transcript rather
 * than a second copy of either.
 */
export function mergeMessagesById(current: UIMessage[], incoming: UIMessage[]): UIMessage[] {
  const missing = incoming.filter(
    (message) => !current.some((existing) => existing.id === message.id)
  );
  return missing.length === 0 ? current : [...current, ...missing];
}

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

export const MAX_EVAL_TOOL_INPUT_CHARS = 500;

export const MAX_EVAL_ACTIVITY_CHARS = 20_000;

export function truncateEvalToolValue(value: unknown, limit: number): unknown {
  if (value === undefined) return value;
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= limit) return value;
  return {
    truncated: true,
    outputPrefix: sliceWellFormed(serialized, limit),
    note: `[truncated: the first ${limit} of ${serialized.length} characters of this value]`,
  };
}

export function truncateEvalToolOutput(output: unknown): unknown {
  return truncateEvalToolValue(output, MAX_EVAL_TOOL_OUTPUT_CHARS);
}

export function unfoldEvalToolOutput(output: unknown): unknown {
  if (output === null || typeof output !== "object") return output;
  const envelope = output as { type?: unknown; value?: unknown };
  if (typeof envelope.type !== "string") return output;

  switch (envelope.type) {
    case "json":
    case "text":
    case "content":
      return envelope.value;
    case "error-text":
    case "error-json":
      // `isError` and `error` are structural, so they survive redaction; `value` does not.
      return { isError: true, error: { type: envelope.type }, value: envelope.value };
    default:
      return output;
  }
}

export function capEvalToolActivity<T extends { toolName: string }>(activity: T[]): unknown[] {
  const kept: unknown[] = [];
  let used = 0;
  for (const entry of activity) {
    const size = JSON.stringify(entry)?.length ?? 0;
    if (used + size > MAX_EVAL_ACTIVITY_CHARS) {
      kept.push({ toolName: entry.toolName, omitted: true });
      continue;
    }
    used += size;
    kept.push(entry);
  }
  return kept;
}

// The customer's own data (payloads, outputs, query rows, file contents, error text)
// must never leave here as itself.
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
        const toolName = String(part.toolName ?? "");
        byId.set(part.toolCallId, {
          toolName,
          input: truncateEvalToolValue(
            redactEvalToolValue(part.input, toolName),
            MAX_EVAL_TOOL_INPUT_CHARS
          ),
        });
      } else if (part.type === "tool-result" && part.toolCallId) {
        const existing = byId.get(part.toolCallId);
        if (existing) {
          existing.output = truncateEvalToolValue(
            redactEvalToolValue(unfoldEvalToolOutput(part.output), existing.toolName),
            MAX_EVAL_TOOL_OUTPUT_CHARS
          );
        }
      }
    }
  }
  return capEvalToolActivity([...byId.values()]) as Array<{
    toolName: string;
    input?: unknown;
    output?: unknown;
  }>;
}

function cleanTitle(raw: string): string {
  const normalized = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ");
  return sliceWellFormed(normalized, 80).trim();
}

/**
 * Title generation in flight, per chat. Started in `onTurnStart` and awaited in
 * `onBeforeTurnComplete`, while the stream is still open. The panel reloads its
 * chat list once, when the turn settles, so the name must be on the row by then
 * or the list reads "New chat".
 */
const pendingTitles = new Map<string, Promise<void>>();

/**
 * Whether this turn is the one that names the chat. Counted in user messages, not in
 * transcript length: a head-started turn arrives with the warm first step already in
 * `uiMessages`, so a length gate would see two messages on the very first exchange and
 * never name the chat at all. A watch's consent record is a user message the user did
 * not type, so it doesn't count as an exchange either.
 */
export function isFirstUserExchange(uiMessages: { role: string; id?: string }[]): boolean {
  const typed = uiMessages.filter(
    (message) => message.role === "user" && !isWatchRequestMessageId(message.id)
  );
  return typed.length <= 1;
}

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
      resolveDashboardAgentModel(resolved.model ?? "anthropic:claude-haiku-4-5"),
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
 * What the turn's model actually sees: replayed tool inputs the API would reject
 * coerced back, the durable state pinned back on, and a cache breakpoint on the last
 * message so the growing conversation prefix is read back cheaply.
 *
 * The between-steps compaction path rebuilds history as the summary alone and never
 * reaches `compactModelMessages`, so the live investigation and watch state is pinned
 * back here instead.
 */
export function prepareTurnMessages(args: {
  messages: ModelMessage[];
  reason: string;
}): ModelMessage[] {
  if (args.messages.length === 0) return args.messages;
  return withCacheBreakpointOnLast(
    sanitizeReplayedToolInputs(
      args.reason === "run" ? args.messages : withDurableState(args.messages, chat.history.all())
    )
  );
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
    locals.set(turnErroredKey, false);

    // Awaited, never chat.defer: a mid-stream refresh must not read an empty
    // transcript.
    await getStore().persistMessages({ chatId, messages: uiMessages });

    // Name the chat on the first exchange, started here so it runs while the model
    // answers. Awaited in `onBeforeTurnComplete`, not here; a failure only costs the
    // generated name.
    if (isFirstUserExchange(uiMessages) && !pendingTitles.has(chatId)) {
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
      providerOptions: withCacheBreakpoint(undefined, "prefix"),
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
    newUIMessages,
    responseMessage,
    clientData,
    chatAccessToken,
    lastEventId,
    runId,
    finishReason,
    error,
  }) => {
    const store = getStore();

    // The run is over, so a card left `in_progress` never settles on its own. The
    // entry survives until the write commits, so a retried `onTurnComplete` settles it.
    const settlements = pendingInvestigationSettlements(chatId);

    // A turn that ended in an error is part of the conversation, not only a stream
    // event: the browser rendered the error chunk but nothing recorded it, so
    // reloading showed a turn that just stops.
    const errored =
      error !== undefined || finishReason === "error" || locals.get(turnErroredKey) === true;
    const failure = errored ? turnFailureMessage(turn) : undefined;

    // One database operation for all of it: transcript, session state, and the rows
    // and closing cards of whatever was left running. Settling a row on a separate
    // operation is what could leave a terminal row whose card never arrived — and the
    // stale sweep only selects `in_progress`, so nothing would ever repair it.
    // Only what this turn produced may be finalised; the rest of the snapshot is history.
    const produced = [...(newUIMessages ?? []), ...(responseMessage ? [responseMessage] : [])]
      .map((message) => (message as { id?: unknown }).id)
      .filter((id): id is string => typeof id === "string");

    const { settled } = await store.persistTurn({
      chatId,
      messages: mergeMessagesById(uiMessages, failure ? [failure] : []),
      finalizeMessageIds: [...produced, ...(failure ? [failure.id] : [])],
      session: {
        publicAccessToken: chatAccessToken,
        lastEventId,
        runId,
      },
      settlements,
    });
    clearOpenInvestigations(chatId);

    // The row is only half of it — the panel renders the winning revision from the
    // transcript's own render_view parts and never reads the investigations table.
    const closingCards = settlementCardMessages(
      chatId,
      settled.map((card) => ({
        investigationId: card.id,
        revision: card.revision,
        state: card.state,
      }))
    );
    const terminal = mergeMessagesById(uiMessages, [
      ...closingCards,
      ...(failure ? [failure] : []),
    ]);
    if (terminal.length > uiMessages.length) {
      // Into the accumulator too, so the next turn's wholesale write keeps them.
      chat.history.set(terminal);
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
  prepareMessages: ({ messages, reason }) => prepareTurnMessages({ messages, reason }),

  // System prompt and model come from the managed prompt set in onTurnStart, so
  // they are dashboard-editable. toStreamTextOptions() supplies the system text
  // with its cache breakpoint, config, telemetry and prepareStep wiring; the model
  // string is resolved through the registry here so streamText keeps a typed model.
  run: async ({ messages, signal, tools }) => {
    const resolved = chat.prompt();
    const options = chat.toStreamTextOptions({ tools });
    let step = 0;
    return streamText({
      ...options,
      model:
        locals.get(dashboardAgentModelKey) ??
        resolveDashboardAgentModel(resolved.model ?? "anthropic:claude-sonnet-4-6"),
      messages,
      abortSignal: signal,
      prepareStep: stepCachePrepareStep(options) as never,
      // Per model call, so the head-start prefix and this one can be compared.
      onStepFinish: (finished) =>
        recordPromptCacheUsage({
          source: "agent-turn",
          usage: finished.usage,
          system: resolved.text,
          tools: tools ?? {},
          step: step++,
          providerMetadata: finished.providerMetadata,
        }),
      // toStreamTextOptions() defaults to a single step; override so the model can
      // call a tool and then answer from its result in the same turn.
      stopWhen: stepCountIs(10),
    });
  },
});
