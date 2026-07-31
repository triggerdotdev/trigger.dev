import { anthropic } from "@ai-sdk/anthropic";
import {
  createDashboardAgentDb,
  ensureChat,
  persistMessages,
  persistTurn,
  setChatTitleIfDefault,
  upsertInvestigationRevision,
  type DashboardAgentDbClient,
  type UpsertInvestigationResult,
} from "@internal/dashboard-agent-db";
import { chat } from "@trigger.dev/sdk/ai";
import { locals, logger, tasks } from "@trigger.dev/sdk";
import {
  createProviderRegistry,
  generateText,
  stepCountIs,
  streamText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from "ai";
import { z } from "zod";
import type { EvalTurnPayload, evalTurn } from "./eval-turn";
import { codeSystemPrompt, systemPrompt, titlePrompt } from "./prompts";
import { buildDashboardAgentTools } from "./tools";

/**
 * The in-dashboard agent, built on chat.agent and deployed as an internal task
 * by the webapp. This is the launch-week dogfood: we run our own product on the
 * primitive we ship.
 *
 * It answers from a dashboard-managed system prompt (Anthropic, resolved via the
 * provider registry) with prompt caching, calls the read-only tools built per
 * turn from the delegated token the `in` proxy injects, persists the
 * conversation to the agent's own datastore (NOT the main DB — the agent has no
 * access to that), and generates the chat title in the background. Runtime
 * history is owned by chat.agent's built-in object-store snapshot; the rows we
 * write here are the display read-model the dashboard's History tab and panel
 * render from.
 */

// One connection pool per worker process. onBoot fires on every fresh worker
// (initial, preloaded, and continuation runs), so the pool is established there
// and reused across turns within the run.
let dbClient: DashboardAgentDbClient | undefined;

function getDb(): DashboardAgentDbClient {
  if (!dbClient) {
    const connectionString = process.env.DASHBOARD_AGENT_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DASHBOARD_AGENT_DATABASE_URL (or DATABASE_URL) must be set for the dashboard agent"
      );
    }
    // Small client pool — the agent runs in many short-lived containers and the
    // PlanetScale pooler does the real pooling.
    dbClient = createDashboardAgentDb(connectionString, { max: 2 });
  }
  return dbClient;
}

// Resolves the `"provider:model-id"` strings on our managed prompts to AI SDK
// models. Anthropic only for now; add another @ai-sdk/* provider here to let
// the dashboard pick its models on a prompt.
const registry = createProviderRegistry({ anthropic });

// The persistence the agent does against its own datastore, behind an interface
// so it can be injected. Production lazily builds one over the env-configured
// Drizzle client (below); unit tests inject a fake via `locals` (the DI pattern
// from the chat.agent testing guide) so the agent never needs a real database.
export interface DashboardAgentStore {
  ensureChat(args: Parameters<typeof ensureChat>[1]): Promise<unknown>;
  persistMessages(args: Parameters<typeof persistMessages>[1]): Promise<unknown>;
  persistTurn(args: Parameters<typeof persistTurn>[1]): Promise<unknown>;
  setChatTitleIfDefault(args: Parameters<typeof setChatTitleIfDefault>[1]): Promise<unknown>;
  /**
   * Commit one investigation revision. The only write the tool lane performs —
   * `render_view`'s investigation executor calls it through the capability wired
   * onto the tool context below.
   */
  upsertInvestigationRevision(
    args: Parameters<typeof upsertInvestigationRevision>[1]
  ): Promise<UpsertInvestigationResult>;
}

export const dashboardAgentStoreKey = locals.create<DashboardAgentStore>("dashboard-agent.store");

// Returns the injected store if a test seeded one, otherwise lazily builds the
// production store over the env-configured Drizzle client and caches it.
function getStore(): DashboardAgentStore {
  const injected = locals.get(dashboardAgentStoreKey);
  if (injected) return injected;
  const { db } = getDb();
  return locals.set(dashboardAgentStoreKey, {
    ensureChat: (args) => ensureChat(db, args),
    persistMessages: (args) => persistMessages(db, args),
    persistTurn: (args) => persistTurn(db, args),
    setChatTitleIfDefault: (args) => setChatTitleIfDefault(db, args),
    upsertInvestigationRevision: (args) => upsertInvestigationRevision(db, args),
  });
}

// Optional language-model override. Production leaves this unset and resolves the
// model from the managed prompt through the provider registry; unit tests inject
// a mock model here so `run()` and title generation never reach a provider.
export const dashboardAgentModelKey = locals.create<LanguageModel>("dashboard-agent.model");

// Optional tool-set override. Production leaves this unset and builds the real
// tools per turn; tests and evals inject a fixture tool set (real schemas,
// stubbed executes) so the model's tool choice can be observed and its answers
// judged without a live API.
export const dashboardAgentToolsKey = locals.create<ToolSet>("dashboard-agent.tools");

// How the per-turn eval is enqueued, behind an interface so it can be injected.
// Production leaves this unset and triggers the real decoupled task; tests
// inject a recorder to observe whether a turn was sampled.
export type DashboardAgentEvalTrigger = (
  payload: EvalTurnPayload,
  options: { idempotencyKey: string }
) => Promise<unknown>;

export const dashboardAgentEvalTriggerKey = locals.create<DashboardAgentEvalTrigger>(
  "dashboard-agent.eval-trigger"
);

function getEvalTrigger(): DashboardAgentEvalTrigger {
  return (
    locals.get(dashboardAgentEvalTriggerKey) ??
    ((payload, options) =>
      tasks.trigger<typeof evalTurn>("dashboard-agent-eval-turn", payload, options))
  );
}

// Fraction of turns to eval, from DASHBOARD_AGENT_EVAL_SAMPLE_RATE. Defaults to
// 1.0 (every turn) — volume is internal and low today. Anything unparseable or
// out of range falls back to 1.0 rather than silently dropping evals; 0 means
// never. Read per turn so the rate can be changed without a redeploy.
function evalSampleRate(): number {
  const raw = process.env.DASHBOARD_AGENT_EVAL_SAMPLE_RATE;
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return 1;
  return parsed;
}

// `Math.random()` is in [0, 1), so rate 0 never samples and rate 1 always does.
function shouldEvalTurn(): boolean {
  return Math.random() < evalSampleRate();
}

// The system prompt is dashboard-managed (text + model + config). Resolving it
// is an API call, so cache it per worker process — workers are short-lived
// (idleTimeoutInSeconds), so a dashboard edit lands within a recycle.
type DashboardAgentMode = "assistant" | "code";

// A turn is in `code` mode when the `in` proxy injected a repo snapshot (i.e. the
// current project has a connected repo). Drives both the tool set and the prompt.
function modeFor(clientData: { repoSnapshot?: unknown } | undefined): DashboardAgentMode {
  return clientData?.repoSnapshot ? "code" : "assistant";
}

let cachedSystemPrompt: Awaited<ReturnType<typeof systemPrompt.resolve>> | undefined;
let cachedCodePrompt: Awaited<ReturnType<typeof codeSystemPrompt.resolve>> | undefined;
async function getSystemPrompt(mode: DashboardAgentMode = "assistant") {
  if (mode === "code") {
    cachedCodePrompt ??= await codeSystemPrompt.resolve({});
    return cachedCodePrompt;
  }
  cachedSystemPrompt ??= await systemPrompt.resolve({});
  return cachedSystemPrompt;
}

function extractText(message: UIMessage): string {
  return (message.parts ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .trim();
}

// Pair this turn's tool-calls with their results (the ground truth the eval
// judge checks the answer against). Works off the model-format messages.
function extractToolActivity(
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
        byId.set(part.toolCallId, { toolName: String(part.toolName ?? ""), input: part.input });
      } else if (part.type === "tool-result" && part.toolCallId) {
        const existing = byId.get(part.toolCallId);
        if (existing) existing.output = part.output;
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

// Generate a short title from the first user message using the cheaper title
// model, then write it only if the chat still has the default title. Runs in
// the background (chat.defer) so it never blocks the response.
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

import { agentPageContextSchema, type WatchSpec } from "@internal/dashboard-agent-contracts";

export type {
  AgentPage,
  AgentPageContext,
  AgentPageSignal,
} from "@internal/dashboard-agent-contracts";

// A chat belongs to an org + user. The current project/env (and the page) are
// per-turn context for the agent, not chat identity — one conversation can span
// several projects/envs. Every field past the org + user pair is optional:
// resumed chats replay their original, older-shaped clientData and must keep
// validating.
export const clientDataSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  currentPage: z.string().optional(),
  // Structured version of `currentPage`: the page the turn was asked from plus
  // the notable things on it. Server-injected by the `in` proxy.
  pageContext: agentPageContextSchema.optional(),
  // Injected server-side by the `in` proxy on each turn (never sent from the
  // browser): a short-lived read-only delegated token for the user, the API
  // origin to call back to, and the current project ref + env its tools read.
  userActorToken: z.string().optional(),
  apiOrigin: z.string().optional(),
  projectRef: z.string().optional(),
  environmentName: z.string().optional(),
  // Injected only when the current project has a connected GitHub repo: a signed,
  // short-lived archive pointer the code-mode source tools read from.
  repoSnapshot: z
    .object({
      tarballUrl: z.string(),
      owner: z.string(),
      repo: z.string(),
      sha: z.string(),
      defaultBranch: z.string().optional(),
    })
    .optional(),
});

/* ------------------------------------------------------------------ *
 * Watch wakes
 * ------------------------------------------------------------------ */

/**
 * The wake, as the agent receives it.
 *
 * A watch fires (or expires) long after the turn that scheduled it, so there is
 * no turn to answer on. The watcher task (`watch-tick.ts`) appends ONE record to
 * this chat's `in` stream with `trigger: "action"`, which is the SDK's
 * non-message input: it wakes (or re-triggers) the agent run and fires `onAction`
 * only — no `onTurnStart`, no `run()`, no `onTurnComplete`, and the turn counter
 * doesn't move. That's why the narration below does its own model call and its
 * own persistence: the turn machinery isn't running.
 *
 * `id` is stable per (watch, outcome) — `watch:{watchId}:{fired|expired}` — and it
 * becomes the narration message's id. That is the dedup: a redelivered wake (the
 * watcher retried after appending but before marking the delivery) finds its
 * message already in the history and narrates nothing.
 */
export type WatchWakeAction = {
  type: "watch.fired" | "watch.expired";
  /** `watch:{watchId}:{status}` — stable, so a redelivery is a no-op. */
  id: string;
  watchId: string;
  /** The watched thing, as the contracts' dedup string. */
  identity: string;
  spec: WatchSpec & { since?: string };
  /** What the final check observed. The numbers the narration must use. */
  facts: Record<string, unknown>;
  /** Why the watch exists, in the user's words. */
  note?: string;
};

// Deliberately lenient on `spec`: a wake must never be lost to a validation
// error because the host persisted a spec field this version doesn't know about.
// The narration reads `kind`, `note` and the cadence; the rest passes through.
export const watchWakeActionSchema = z.object({
  type: z.enum(["watch.fired", "watch.expired"]),
  id: z.string(),
  watchId: z.string(),
  identity: z.string().default(""),
  spec: z
    .object({
      kind: z.string(),
      note: z.string().optional(),
      checkEveryMinutes: z.number().optional(),
    })
    .passthrough(),
  facts: z.record(z.unknown()).default({}),
  note: z.string().optional(),
});

// The wake's own line. How a wake is narrated (once, briefly, outcome + facts +
// one suggestion) lives in the managed system prompt's "Watches" section, which
// is the cached block — this is only the per-wake framing.
const WAKE_INSTRUCTION =
  "This is a watch wake, not a question: nobody is waiting on a reply. Write ONE short message — the outcome, the numbers from the facts below, and one suggested next step. No tools, no new investigation, no recap.";

/**
 * Coerce replayed tool-call inputs the Anthropic API would reject back to `{}`.
 *
 * The model occasionally emits a no-arg tool call with a non-object input (empty
 * string, or `null` — which `typeof` also calls "object"), the SDK replays it
 * into history verbatim, and the API then fails the whole turn with
 * "tool_use.input: Input should be an object". Used by `prepareMessages` on
 * normal turns and by the wake narration, which builds its model call directly.
 */
export function sanitizeReplayedToolInputs(messages: ModelMessage[]): ModelMessage[] {
  const isBadInput = (part: unknown) =>
    typeof part === "object" &&
    part !== null &&
    (part as { type?: string }).type === "tool-call" &&
    (typeof (part as { input?: unknown }).input !== "object" ||
      (part as { input?: unknown }).input === null);

  return messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    if (!message.content.some(isBadInput)) return message;
    return {
      ...message,
      content: message.content.map((part) => (isBadInput(part) ? { ...part, input: {} } : part)),
    };
  }) as ModelMessage[];
}

// Same Anthropic breakpoint `prepareMessages` rolls onto a turn's last message.
function withCacheBreakpointOnLast(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1]!;
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      providerOptions: {
        ...last.providerOptions,
        anthropic: { cacheControl: { type: "ephemeral" } },
      },
    },
  ];
}

function wakeOutcome(action: WatchWakeAction): string {
  if (action.type === "watch.fired") return "the condition happened";
  // An expiry can be a real answer: the condition became impossible (e.g. the
  // watched run was cancelled), which is not the same as running out of time.
  if ((action.facts as { reason?: string } | undefined)?.reason === "terminal_unsatisfied") {
    return "the condition can no longer happen — that is the answer, not a timeout";
  }
  return "the watch ended without firing";
}

function wakePrompt(action: WatchWakeAction): string {
  return [
    WAKE_INSTRUCTION,
    `Outcome: ${wakeOutcome(action)}.`,
    `Watching: ${action.spec.kind}${action.identity ? ` (${action.identity})` : ""}.`,
    action.note ? `Why the user asked for it: ${action.note}` : undefined,
    `Facts from the check:\n${JSON.stringify(action.facts, null, 2)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Did the turn that CREATED this watch already tell the user its outcome?
 *
 * A watch whose condition was already true is resolved inline by the host and
 * answered in the same turn, so its wake is delivered later only as a backstop —
 * and it must not repeat an answer the user already has. The proof has to be
 * specific to this watch and durable, so it is read out of the persisted
 * transcript: a completed `schedule_watch` call that returned an immediate outcome
 * FOR THIS WATCH, followed by assistant prose in that message or a later one. The
 * chat's own "last message" watermark proves nothing — a question, an error turn,
 * or another watch's wake moves it too.
 *
 * Anything short of the pair means no narration exists (the turn died before it,
 * or wrote nothing), and the wake narrates normally.
 */
export function hasInlineWatchNarration(uiMessages: UIMessage[], watchId: string): boolean {
  const resolvedAt = uiMessages.findIndex(
    (message) =>
      message.role === "assistant" &&
      message.parts.some((part) => {
        if (part.type !== "tool-schedule_watch") return false;
        const output = (part as { output?: { watchId?: unknown; immediate?: unknown } }).output;
        return output?.watchId === watchId && output.immediate !== undefined;
      })
  );
  if (resolvedAt === -1) return false;

  return uiMessages
    .slice(resolvedAt)
    .some(
      (message) =>
        message.role === "assistant" &&
        message.parts.some(
          (part) => part.type === "text" && (part as { text?: string }).text?.trim()
        )
    );
}

/**
 * Narrate one wake, exactly once.
 *
 * Streams so the panel shows it arriving live, then writes it into both places a
 * turn normally would: `chat.history` (the runtime transcript the model sees next
 * turn) and the display read-model. Both happen before `onAction` returns —
 * `chat.history` mutations are only picked up immediately after the hook.
 */
async function narrateWatchWake(args: {
  action: WatchWakeAction;
  chatId: string;
  clientData: z.infer<typeof clientDataSchema> | undefined;
  uiMessages: UIMessage[];
  /** The same history in model form, as the action event supplies it. */
  messages: ModelMessage[];
}): Promise<void> {
  const { action, chatId, uiMessages } = args;
  const messageId = `wake:${action.id}`;

  // Dedup on the action id. Durable, because the history it checks is the
  // snapshot the SDK reseeds on every boot — not per-process state.
  if (uiMessages.some((message) => message.id === messageId)) {
    logger.info("dashboard-agent watch wake already narrated; skipping", {
      chatId,
      watchId: action.watchId,
      actionId: action.id,
    });
    return;
  }

  // The other way this outcome can already have been told: the turn that created
  // the watch answered it inline. One telling per outcome, so the wake is silent
  // here — the delivery is still marked, which closes the row out.
  if (hasInlineWatchNarration(uiMessages, action.watchId)) {
    logger.info("dashboard-agent watch outcome was narrated inline; skipping the wake", {
      chatId,
      watchId: action.watchId,
    });
    return;
  }

  const resolved = await getSystemPrompt(modeFor(args.clientData));
  const result = streamText({
    model:
      locals.get(dashboardAgentModelKey) ??
      registry.languageModel(
        (resolved.model ?? "anthropic:claude-sonnet-4-6") as `anthropic:${string}`
      ),
    system: resolved.text,
    // The conversation so far plus the wake. No tools: a wake reports what the
    // check already established, and it carries no delegated token to read with.
    // The breakpoint goes on the last message of the EXISTING prefix (not on the
    // wake, which is unique and would only ever be a cache write), so the wake
    // reads back the same cached prefix a normal turn would.
    messages: [
      ...withCacheBreakpointOnLast(sanitizeReplayedToolInputs(args.messages)),
      { role: "user" as const, content: wakePrompt(action) },
    ],
    ...resolved.toAISDKTelemetry(),
  });

  // Pipe explicitly (rather than returning the result) so the final text is in
  // hand for the history + read-model writes below. The streamed message must
  // carry the SAME id the copy below is persisted under — the panel merges the
  // live stream with the loaded history by message id, and two ids for one
  // narration render it twice.
  await chat.pipe(result.toUIMessageStream({ generateMessageId: () => messageId }));
  const text = (await result.text).trim();
  if (!text) return;

  const message: UIMessage = {
    id: messageId,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
  const messages = [...uiMessages, message];
  chat.history.set(messages);
  await getStore().persistMessages({ chatId, messages });
}

export const dashboardAgent = chat.agent({
  id: "dashboard-agent",
  clientDataSchema,
  // The only action the agent accepts: a watch wake, appended by the watcher
  // task. Actions are not turns — see `narrateWatchWake`.
  actionSchema: watchWakeActionSchema,
  // Latency levers come next (Head Start, prompt caching, AI Prompts). Scaffold
  // keeps a short idle window so suspended runs release their DB pool.
  idleTimeoutInSeconds: 60,

  // Read-only tools, rebuilt per turn from the delegated token the `in` proxy
  // injects. Declaring them here (not just inside run) lets the SDK re-apply
  // each tool's output conversion when it replays prior-turn history.
  // The `investigations` capability is the one seam from the tool lane to the
  // agent's datastore: the store is reached here (where the chat id is known) and
  // handed to the tools as a single narrow write, so `tools.ts` stays free of the
  // database package.
  tools: async ({ chatId, clientData }) =>
    locals.get(dashboardAgentToolsKey) ??
    buildDashboardAgentTools({
      ...(clientData ?? {}),
      chatId,
      investigations: {
        upsert: (params) => getStore().upsertInvestigationRevision({ ...params, chatId }),
      },
    }),

  onBoot: async () => {
    // Establish the store (and, in production, its connection pool) once.
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

  // A watch fired or expired. The narration is one message, deduped on the
  // action id, and it returns void: the stream is piped inside so the final
  // text can be written to the history and the read-model.
  onAction: async ({ action, chatId, clientData, uiMessages, messages }) => {
    await narrateWatchWake({
      action: action as WatchWakeAction,
      chatId,
      clientData,
      uiMessages,
      messages,
    });
  },

  onTurnStart: async ({ chatId, uiMessages, clientData }) => {
    // Make the user's message durable in the display copy before the model
    // starts streaming. Awaited, never chat.defer — a mid-stream refresh must
    // not read an empty transcript.
    await getStore().persistMessages({ chatId, messages: uiMessages });

    // Load the dashboard-managed system prompt for this turn. The code-mode
    // variant is used when the project has a connected repo. Set every turn so
    // continuation runs (which skip onChatStart) still get it; the resolve is
    // cached per process. The Anthropic cache breakpoint on the system block
    // carries through toStreamTextOptions() and survives suspend/resume.
    chat.prompt.set(await getSystemPrompt(modeFor(clientData)), {
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
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
  }) => {
    // Persist the finalized transcript + refreshed session state in one
    // transaction so a refresh on the next page load reads both consistently.
    const store = getStore();
    await store.persistTurn({
      chatId,
      messages: uiMessages,
      session: {
        publicAccessToken: chatAccessToken,
        lastEventId,
        runId,
      },
    });

    // First exchange: generate a title with the cheaper title model in the
    // background. Deferred from onTurnComplete, so it runs during the idle wait
    // and never blocks the response; the write is conditional (default title).
    if (uiMessages.length <= 2) {
      chat.defer(generateAndSaveTitle(store, chatId, uiMessages));
    }

    // Runtime eval: score this turn in a SEPARATE, idempotency-keyed task so it
    // never blocks or bills the agent run. Best-effort — enqueue failures must
    // not break the turn. Sampled by DASHBOARD_AGENT_EVAL_SAMPLE_RATE (default:
    // every turn, since volume is internal and low).
    if (clientData?.organizationId && clientData?.userId && responseMessage && shouldEvalTurn()) {
      try {
        const resolved = await getSystemPrompt(modeFor(clientData));
        // The current turn's question. On a Head Start turn it arrives in the
        // boot payload (not in newUIMessages), so take the latest user message
        // from the full transcript, which holds for normal turns too.
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
            toolActivity: extractToolActivity(newMessages),
          } satisfies EvalTurnPayload,
          { idempotencyKey: `eval:${chatId}:${turn}` }
        );
      } catch (error) {
        logger.error("Failed to enqueue dashboard-agent turn eval", { error });
      }
    }
  },

  // Roll an Anthropic cache breakpoint onto the last message every turn so the
  // growing conversation prefix is cached and read back cheaply. Composes with
  // the system-block breakpoint above. This is the canonical prompt-caching
  // pattern; chat.agent keeps the Head Start handover's tool-approval tail
  // intact across this hook, so it's safe on a resume turn.
  prepareMessages: ({ messages }) => {
    if (messages.length === 0) return messages;
    const sanitized = sanitizeReplayedToolInputs(messages);

    const last = sanitized[sanitized.length - 1];
    return [
      ...sanitized.slice(0, -1),
      {
        ...last,
        providerOptions: {
          ...last.providerOptions,
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
    ];
  },

  // System prompt + model come from the managed prompt (set in onTurnStart),
  // so they're dashboard-editable. toStreamTextOptions() supplies the system
  // text (with its cache breakpoint), config, telemetry, and prepareStep
  // wiring; the model string is resolved through the registry here so
  // streamText keeps a typed model.
  run: async ({ messages, signal, tools }) => {
    const resolved = chat.prompt();
    return streamText({
      ...chat.toStreamTextOptions({ tools }),
      // Tests inject a mock model via locals; production resolves the managed
      // prompt's model through the provider registry.
      model:
        locals.get(dashboardAgentModelKey) ??
        registry.languageModel(
          (resolved.model ?? "anthropic:claude-sonnet-4-6") as `anthropic:${string}`
        ),
      messages,
      abortSignal: signal,
      // toStreamTextOptions() defaults to a single step; override so the model
      // can call a tool and then answer from its result in the same turn.
      stopWhen: stepCountIs(10),
    });
  },
});
