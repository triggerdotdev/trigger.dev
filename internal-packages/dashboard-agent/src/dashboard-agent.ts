import {
  isAgentRequestMessageId,
  isTurnRequestMessageId,
  sliceWellFormed,
} from "@internal/dashboard-agent-contracts";
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
  dashboardAgentStorage,
  getStore,
  pendingActionTurnKey,
  getSystemPrompt,
  modeFor,
  resolveDashboardAgentModel,
  sanitizeReplayedToolInputs,
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
 * never name the chat at all. A watch's consent record, and the request a wake or
 * investigation turn answers, are user messages the user did not type, so they don't
 * count as an exchange either.
 */
export function isFirstUserExchange(uiMessages: { role: string; id?: string }[]): boolean {
  const typed = uiMessages.filter(
    (message) => message.role === "user" && !isAgentRequestMessageId(message.id)
  );
  // Exactly one: a chat a watch created, whose only user-role messages are requests
  // the agent filed for itself, has had no exchange yet and keeps its name.
  return typed.length === 1;
}

async function generateAndSaveTitle(
  store: DashboardAgentStore,
  chatId: string,
  uiMessages: UIMessage[]
): Promise<void> {
  // The user's own words, never a request the agent filed for itself.
  const firstUserMessage = uiMessages.find(
    (message) => message.role === "user" && !isAgentRequestMessageId(message.id)
  );
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

/** The output budget of a small-model wake: the headline and a sentence around it. */
const HAIKU_WAKE_MAX_OUTPUT_TOKENS = 300;

export const dashboardAgent = chat.agent({
  id: "dashboard-agent",
  clientDataSchema,
  // The conversation lives in the agent's own Postgres, one row per message, and the
  // runtime writes it: the message being answered before the model runs, the answer
  // when the turn completes, every `chat.history` edit an action makes, and the
  // cursors a refreshed panel resumes from. The panel reads the same rows.
  storage: dashboardAgentStorage,
  // A watch action files a request and answers it with a turn; see `watch-actions.ts`.
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

  // Every action is a watch action, handled in `watch-actions.ts`. The lane files
  // the wake or the investigation brief as a request under a stable id and returns
  // `chat.turn()`, so a full turn answers it; a fixed-wording wake is an edit only.
  onAction: async ({ action, chatId, clientData, uiMessages }) =>
    handleWatchAction({ action, chatId, clientData, uiMessages }),

  onTurnStart: async ({ chatId, uiMessages, clientData }) => {
    locals.set(turnErroredKey, false);

    // An action turn answers the request `onAction` just filed, so that request is the
    // last message. Any other turn is the user's: a marker still set here belongs to an
    // action turn whose `onTurnComplete` failed on both attempts, and it must not strip
    // this turn's tools or skip its eval.
    const last = uiMessages.at(-1);
    if (!(last?.role === "user" && isTurnRequestMessageId(last.id))) {
      locals.set(pendingActionTurnKey, undefined);
    }

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
    chat.prompt.set(
      await getSystemPrompt(modeFor(clientData), { watchEnabled: clientData?.watchEnabled }),
      {
        providerOptions: withCacheBreakpoint(undefined, "prefix"),
      }
    );
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
    runId,
    finishReason,
    error,
  }) => {
    const store = getStore();
    // Read now, cleared at the end: the runtime retries this hook after a failure,
    // and the retry must still know it is finishing an action turn.
    const actionTurn = locals.get(pendingActionTurnKey);

    // The run is over, so a card left `in_progress` never settles on its own. The
    // entry survives until the write commits, so a retried `onTurnComplete` settles it.
    const settlements = pendingInvestigationSettlements(chatId);

    // A turn that ended in an error is part of the conversation, not only a stream
    // event: the browser rendered the error chunk but nothing recorded it, so
    // reloading showed a turn that just stops.
    const errored =
      error !== undefined || finishReason === "error" || locals.get(turnErroredKey) === true;
    const failure = errored ? turnFailureMessage(turn) : undefined;

    // The rows and closing cards of whatever was left running, in one operation. The
    // row and its card have to commit together: a settled row whose card never arrived
    // is a terminal row the stale sweep no longer selects, so nothing would repair it.
    const { cards } = await store.settleTurnInvestigations({ chatId, settlements });
    clearOpenInvestigations(chatId);

    // The transcript is the runtime's: it saves this turn's answer right after this
    // hook, and anything put into the accumulator here goes into that same save. The
    // closing cards were already written by the settle (an id-deduped append), so the
    // runtime's write of the same ids replaces them in place with the same bytes.
    const terminal = mergeMessagesById(uiMessages, [
      ...(cards as UIMessage[]),
      ...(failure ? [failure] : []),
    ]);
    if (terminal.length > uiMessages.length) {
      chat.history.set(terminal);
    }

    // Score this turn in a separate, idempotency-keyed task so it never blocks or
    // bills the agent run. Best-effort: an enqueue failure must not break the turn.
    // A wake or investigation turn is the agent talking to itself; nobody asked, so
    // there is no answer to judge.
    if (
      !actionTurn &&
      clientData?.organizationId &&
      clientData?.userId &&
      responseMessage &&
      shouldEvalTurn()
    ) {
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
          const resolved = await getSystemPrompt(modeFor(clientData), {
            watchEnabled: clientData.watchEnabled,
          });
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

    // Consumed: the next turn is whatever the user sends.
    locals.set(pendingActionTurnKey, undefined);
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
  run: async ({ messages, signal, tools: turnTools }) => {
    const resolved = chat.prompt();
    // A wake turn runs without tools: it reports what the check already established
    // and carries no delegated token to read with. Decided here rather than in the
    // `tools` hook, which the runtime resolves before `onAction` files the wake.
    const actionTurn = locals.get(pendingActionTurnKey);
    const wake = actionTurn?.kind === "wake";
    const tools = wake ? {} : turnTools;
    // A wake the plan gave a headline is a sentence or two on the small model, bounded
    // so a chatty turn cannot run up the bill on something nobody asked.
    const smallWake = wake && actionTurn.model === "haiku";
    const options = chat.toStreamTextOptions({ tools });
    let step = 0;
    return streamText({
      ...options,
      model:
        locals.get(dashboardAgentModelKey) ??
        resolveDashboardAgentModel(
          smallWake
            ? "anthropic:claude-haiku-4-5"
            : (resolved.model ?? "anthropic:claude-sonnet-4-6")
        ),
      ...(smallWake ? { maxOutputTokens: HAIKU_WAKE_MAX_OUTPUT_TOKENS } : {}),
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
      // call a tool and then answer from its result in the same turn. A wake has no
      // tools, so it has nothing to do with a second step.
      stopWhen: stepCountIs(wake ? 1 : 10),
    });
  },
});
