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

/** Cap on each tool input. Smaller: an input is a handful of arguments, or a query. */
export const MAX_EVAL_TOOL_INPUT_CHARS = 500;

/**
 * Cap on the whole turn's activity. Per-value caps bound one tool call; a ten-step
 * investigation still sends ten of them, and that total is what the judge is billed for.
 */
export const MAX_EVAL_ACTIVITY_CHARS = 20_000;

/** Marks the prefix as a prefix, so the judge doesn't read a cut value as the whole one. */
export function truncateEvalToolValue(value: unknown, limit: number): unknown {
  if (value === undefined) return value;
  const serialized = JSON.stringify(value);
  if (serialized === undefined || serialized.length <= limit) return value;
  return {
    truncated: true,
    outputPrefix: serialized.slice(0, limit),
    note: `[truncated: the first ${limit} of ${serialized.length} characters of this value]`,
  };
}

export function truncateEvalToolOutput(output: unknown): unknown {
  return truncateEvalToolValue(output, MAX_EVAL_TOOL_OUTPUT_CHARS);
}

/**
 * Unfold the SDK's tool-output envelope (`{ type, value }`) before redaction.
 *
 * Left folded, an `error-text` result is one string under a `value` key, so a message
 * that quotes the record the tool choked on travels whole. Unfolded, the error is a
 * fact the judge can see (a tool errored, of this kind) and its text is redacted like
 * any other free-text field.
 */
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

/**
 * Drop the tail of an oversized turn, keeping every tool name. The judge is told which
 * calls it can't see rather than being handed a silently short list.
 */
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

// Pair this turn's tool-calls with their results — the ground truth the eval judge
// checks the answer against. In this order: unfold the envelope, keep only the
// structural fields, cap each value, then cap the turn. The customer's own data
// (payloads, outputs, query rows, file contents, error text) never leaves as itself.
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
  step?: number;
  providerMetadata?: unknown;
}): void {
  try {
    logger.info("dashboard-agent prompt cache", {
      ...promptCacheAttributes({
        source: args.source,
        usage: args.usage,
        prefix: describePromptPrefix({ system: args.system, tools: args.tools }),
      }),
      ...stepCacheAttributes(args.step, args.providerMetadata),
    });
  } catch (error) {
    // Measurement must never fail a turn.
    logger.debug("dashboard-agent prompt cache measurement failed", { error });
  }
}

/**
 * The provider's own per-step cache counts, under the names Anthropic reports them by.
 * `null` means it reported nothing — never a substituted zero, or a step with no cache
 * activity would read the same as a step the provider said nothing about.
 */
export function stepCacheAttributes(
  step: number | undefined,
  providerMetadata: unknown
): Record<string, unknown> {
  const anthropic = (providerMetadata as { anthropic?: Record<string, unknown> } | undefined)
    ?.anthropic;
  const write = anthropic?.cacheCreationInputTokens;
  const read = anthropic?.cacheReadInputTokens;
  return {
    "dashboard_agent.step": step ?? null,
    "gen_ai.usage.cache_creation_input_tokens": typeof write === "number" ? write : null,
    "gen_ai.usage.cache_read_input_tokens": typeof read === "number" ? read : null,
  };
}

/**
 * The step-level breakpoint: 5 minutes, because it only has to survive to the next step
 * of the same turn. The stable system + tools prefix keeps the 1-hour breakpoint
 * (`PROMPT_CACHE_CONTROL`), which is what has to survive user think time between turns.
 */
export const STEP_CACHE_CONTROL = { type: "ephemeral", ttl: "5m" } as const;

/**
 * How much new history a step must have accumulated before it is worth marking.
 *
 * A cache write costs about 1.25x the input price and a read about 0.1x, so a
 * breakpoint pays for itself only if a later step reads it — and Anthropic refuses to
 * cache a prefix shorter than roughly 1024 tokens at all, silently. Below this, marking
 * every step would be pure write premium on a cache that never gets created.
 */
export const MIN_STEP_CACHE_CHARS = 4_096;

type MaybeCached = { providerOptions?: Record<string, unknown> };

function cacheControlTtl(message: MaybeCached): string | undefined {
  const anthropic = message.providerOptions?.anthropic as
    | { cacheControl?: { ttl?: unknown } }
    | undefined;
  const ttl = anthropic?.cacheControl?.ttl;
  return typeof ttl === "string" ? ttl : undefined;
}

/** Strips a step breakpoint we set on an earlier step; leaves the long-lived ones. */
function withoutStepBreakpoint<T extends MaybeCached>(message: T): T {
  if (cacheControlTtl(message) !== STEP_CACHE_CONTROL.ttl) return message;
  const { anthropic: _dropped, ...rest } = message.providerOptions as Record<string, unknown>;
  return { ...message, providerOptions: rest };
}

/**
 * Roll one 5-minute breakpoint onto the end of the accumulated history, so the next step
 * reads back this step's tool results instead of paying for them again.
 *
 * At most one such breakpoint exists at a time — earlier ones are stripped — which keeps
 * the request inside Anthropic's four-breakpoint limit alongside the system block and the
 * per-turn history breakpoint.
 */
export function markStepCacheBreakpoint<T extends MaybeCached>(messages: T[]): T[] {
  if (messages.length === 0) return messages;

  // Everything after the newest long-lived breakpoint is what this turn has added.
  let lastLongLived = -1;
  messages.forEach((message, index) => {
    const ttl = cacheControlTtl(message);
    if (ttl !== undefined && ttl !== STEP_CACHE_CONTROL.ttl) lastLongLived = index;
  });
  const tail = messages.slice(lastLongLived + 1);
  if ((JSON.stringify(tail)?.length ?? 0) < MIN_STEP_CACHE_CHARS) {
    return messages.map(withoutStepBreakpoint);
  }

  const stripped = messages.map(withoutStepBreakpoint);
  const last = stripped[stripped.length - 1]!;
  return [
    ...stripped.slice(0, -1),
    {
      ...last,
      providerOptions: {
        ...last.providerOptions,
        anthropic: { cacheControl: STEP_CACHE_CONTROL },
      },
    },
  ];
}

type PrepareStepArgs = { messages: ModelMessage[] };
type PrepareStepResult = { messages?: ModelMessage[] } | undefined;
type PrepareStepFn = (args: never) => PrepareStepResult | Promise<PrepareStepResult>;

/**
 * Wraps the SDK's own `prepareStep` (compaction, steering, background context) rather
 * than replacing it: whatever it returns is what gets the breakpoint.
 */
export function withStepCacheBreakpoint(inner: PrepareStepFn | undefined): PrepareStepFn {
  return (async (args: PrepareStepArgs) => {
    const base = await inner?.(args as never);
    const messages = base?.messages ?? args.messages;
    return { ...base, messages: markStepCacheBreakpoint(messages) };
  }) as PrepareStepFn;
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
    const options = chat.toStreamTextOptions({ tools });
    let step = 0;
    return streamText({
      ...options,
      model:
        locals.get(dashboardAgentModelKey) ??
        registry.languageModel(
          (resolved.model ?? "anthropic:claude-sonnet-4-6") as `anthropic:${string}`
        ),
      messages,
      abortSignal: signal,
      // Wraps, never replaces: `toStreamTextOptions` owns compaction and steering here.
      prepareStep: withStepCacheBreakpoint(
        (options as { prepareStep?: PrepareStepFn }).prepareStep
      ) as never,
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
