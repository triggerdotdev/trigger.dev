import { anthropic } from "@ai-sdk/anthropic";
import {
  appendChatMessageOnce,
  createDashboardAgentDb,
  ensureChat,
  findOpenInvestigationForChat,
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
  readUIMessageStream,
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
 * by the webapp.
 *
 * Persistence goes to the agent's own datastore, never the main DB — the agent
 * has no access to that. chat.agent owns the runtime history snapshot; the rows
 * written here are the display read-model the dashboard renders from.
 */

// One connection pool per worker process, established in onBoot (which fires on
// every fresh worker) and reused across the run's turns.
let dbClient: DashboardAgentDbClient | undefined;

function getDb(): DashboardAgentDbClient {
  if (!dbClient) {
    const connectionString = process.env.DASHBOARD_AGENT_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DASHBOARD_AGENT_DATABASE_URL (or DATABASE_URL) must be set for the dashboard agent"
      );
    }
    // Small pool: many short-lived containers, and the pooler does the real pooling.
    dbClient = createDashboardAgentDb(connectionString, { max: 2 });
  }
  return dbClient;
}

// Resolves the `"provider:model-id"` strings on our managed prompts to AI SDK
// models. Add another @ai-sdk/* provider here to allow it on a prompt.
const registry = createProviderRegistry({ anthropic });

// The agent's persistence, behind an interface so tests can inject a fake via
// `locals` and never need a real database.
export interface DashboardAgentStore {
  ensureChat(args: Parameters<typeof ensureChat>[1]): Promise<unknown>;
  persistMessages(args: Parameters<typeof persistMessages>[1]): Promise<unknown>;
  /**
   * Id-deduped single-message append. The wake narration writes through this
   * rather than `persistMessages`: a wake runs without a client, so the session's
   * view can miss host-appended blocks and a wholesale write would drop them.
   */
  appendMessage(args: Parameters<typeof appendChatMessageOnce>[1]): Promise<unknown>;
  persistTurn(args: Parameters<typeof persistTurn>[1]): Promise<unknown>;
  setChatTitleIfDefault(args: Parameters<typeof setChatTitleIfDefault>[1]): Promise<unknown>;
  /** Commit one investigation revision. The only write the tool lane performs. */
  upsertInvestigationRevision(
    args: Parameters<typeof upsertInvestigationRevision>[1]
  ): Promise<UpsertInvestigationResult>;
  /**
   * The freshest card this chat still has open. A consented wake's investigating
   * turn must revise the row the wake seeded, not open a second one.
   */
  findOpenInvestigation(
    args: Parameters<typeof findOpenInvestigationForChat>[1]
  ): Promise<{ id: string; projectRef: string; environmentRef: string } | null>;
}

export const dashboardAgentStoreKey = locals.create<DashboardAgentStore>("dashboard-agent.store");

/**
 * The investigations this turn left open, keyed by chat id.
 *
 * The prompt tells the model to render a terminal verdict last, but it can run
 * out of steps or have the render rejected. An `in_progress` row outlives the
 * run that wrote it, so the user is left watching a spinner forever. Every
 * committed revision is tracked here and anything still open is settled in
 * `onTurnComplete`.
 */
type OpenInvestigation = { projectRef: string; environmentRef: string; state: InvestigationState };

const openInvestigations = new Map<string, Map<string, OpenInvestigation>>();

function trackInvestigationOutcome(
  chatId: string,
  id: string,
  params: { projectRef: string; environmentRef: string; state: unknown }
): void {
  const parsed = investigationStateSchema.safeParse(params.state);
  const open = openInvestigations.get(chatId);
  // A terminal outcome, or a state we can't read, drops the entry: only a card
  // known to be still running is worth force-settling.
  if (!parsed.success || parsed.data.outcome !== "in_progress") {
    open?.delete(id);
    if (open?.size === 0) openInvestigations.delete(chatId);
    return;
  }
  const forChat = open ?? new Map<string, OpenInvestigation>();
  forChat.set(id, {
    projectRef: params.projectRef,
    environmentRef: params.environmentRef,
    state: parsed.data,
  });
  openInvestigations.set(chatId, forChat);
}

/**
 * Force-settle whatever this turn left `in_progress`, as one more revision on
 * the same investigation. Best-effort: a failed settle must not fail a turn the
 * user already got an answer from, but it is logged.
 */
async function settleOpenInvestigations(store: DashboardAgentStore, chatId: string): Promise<void> {
  const open = openInvestigations.get(chatId);
  if (!open || open.size === 0) return;
  openInvestigations.delete(chatId);

  for (const [id, entry] of open) {
    try {
      await store.upsertInvestigationRevision({
        id,
        chatId,
        projectRef: entry.projectRef,
        environmentRef: entry.environmentRef,
        state: forceSettledInvestigationState(entry.state),
      });
    } catch (error) {
      logger.error("Failed to settle an investigation left in progress", { chatId, id, error });
    }
  }
}

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

function getStore(): DashboardAgentStore {
  const injected = locals.get(dashboardAgentStoreKey);
  if (injected) return injected;
  const { db } = getDb();
  return locals.set(dashboardAgentStoreKey, {
    ensureChat: (args) => ensureChat(db, args),
    persistMessages: (args) => persistMessages(db, args),
    appendMessage: (args) => appendChatMessageOnce(db, args),
    persistTurn: (args) => persistTurn(db, args),
    setChatTitleIfDefault: (args) => setChatTitleIfDefault(db, args),
    upsertInvestigationRevision: (args) => upsertInvestigationRevision(db, args),
    findOpenInvestigation: (args) => findOpenInvestigationForChat(db, args),
  });
}

// Optional language-model override. Unset in production; tests inject a mock so
// `run()` and title generation never reach a provider.
export const dashboardAgentModelKey = locals.create<LanguageModel>("dashboard-agent.model");

// Optional tool-set override. Unset in production; tests and evals inject a
// fixture tool set (real schemas, stubbed executes).
export const dashboardAgentToolsKey = locals.create<ToolSet>("dashboard-agent.tools");

// How the per-turn eval is enqueued. Unset in production; tests inject a
// recorder to observe whether a turn was sampled.
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

// Fraction of turns to eval, from DASHBOARD_AGENT_EVAL_SAMPLE_RATE. Anything
// unparseable or out of range falls back to 1 rather than silently dropping
// evals. Read per turn so the rate can change without a redeploy.
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

// The system prompt is dashboard-managed. Resolving it is an API call, so it is
// cached per worker process; workers are short-lived, so a dashboard edit lands
// within a recycle.
type DashboardAgentMode = "assistant" | "code";

// A turn is in `code` mode when the project has a connected repo. Drives both the
// tool set and the prompt.
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

// Pair this turn's tool-calls with their results — the ground truth the eval
// judge checks the answer against.
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

import {
  agentPageContextSchema,
  forceSettledInvestigationState,
  formatTriggerUri,
  investigationStateSchema,
  watchResolutions,
  watchResultNeedsAttention,
  type InvestigationState,
  type WatchObservedOutcome,
  type WatchResolution,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";

export type {
  AgentPage,
  AgentPageContext,
  AgentPageSignal,
} from "@internal/dashboard-agent-contracts";

// A chat belongs to an org + user; project/env/page are per-turn context, since
// one conversation can span several projects. Everything past the org + user pair
// is optional because resumed chats replay older-shaped clientData and must keep
// validating.
export const clientDataSchema = z.object({
  userId: z.string(),
  organizationId: z.string(),
  projectId: z.string().optional(),
  environmentId: z.string().optional(),
  currentPage: z.string().optional(),
  // Structured version of `currentPage`, injected by the `in` proxy.
  pageContext: agentPageContextSchema.optional(),
  // Injected server-side by the `in` proxy each turn, never sent from the
  // browser: a short-lived read-only delegated token, the API origin to call
  // back to, and the project ref + env its tools read.
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

/**
 * The wake, as the agent receives it.
 *
 * A watch resolves long after the turn that scheduled it, so `watch-tick.ts`
 * appends one record to the chat's `in` stream with `trigger: "action"`. That
 * fires `onAction` only — no `onTurnStart`, `run()` or `onTurnComplete`, and the
 * turn counter doesn't move — which is why the narration below does its own model
 * call and its own persistence.
 *
 * `id` is stable per (watch, outcome) and becomes the narration message's id, so a
 * redelivered wake finds its message in the history and narrates nothing.
 *
 * `type` keeps the fired/expired encoding as the stable TRANSPORT only. How the
 * watch ended travels in `resolution`, what was seen in `observed`.
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
  /** How the watch ended: met, window completed, or impossible. */
  resolution?: WatchResolution;
  /** What was true when it ended: the run's final status, the depth, the count. */
  observed?: WatchObservedOutcome;
  /** Why the watch exists, in the user's words. */
  note?: string;
  /**
   * The user consented at creation to an investigation after an ATTENTION
   * outcome. It relaxes one rule, "never a new investigation unprompted", and
   * only for that outcome.
   */
  investigateOnAttention?: boolean;
};

// Deliberately lenient on `spec`: a wake must never be lost to a validation error
// because the host persisted a field this version doesn't know about.
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
  // Optional for the same reason: an older watcher predating the resolution model
  // sends neither, and the narration falls back to the transport encoding.
  resolution: z.enum(watchResolutions).optional(),
  observed: z.record(z.unknown()).optional(),
  note: z.string().optional(),
  investigateOnAttention: z.boolean().optional(),
});

/**
 * The second half of a consented watch: conduct the investigation the wake opened.
 *
 * Sent by the webapp, never by the watcher or a client, right after a delivered
 * wake on an attention outcome the creator consented to. It carries a freshly
 * minted delegated token in the record's metadata, the same way the `in` proxy
 * injects a turn's token, so this turn can read like any other.
 *
 * It is an action rather than a turn because nobody asked a question: the wake
 * landed as its own message and the findings arrive as another one.
 */
export type WatchInvestigateAction = {
  type: "watch.investigate";
  /** `watch:{watchId}:{status}:investigate` — stable, so a redelivery is a no-op. */
  id: string;
  watchId: string;
  identity: string;
  spec: WatchSpec & { since?: string };
  facts?: Record<string, unknown>;
  resolution?: WatchResolution;
  observed?: WatchObservedOutcome;
  note?: string;
  /**
   * The card to revise, when the sender knows it. Usually absent: the wake seeds
   * the row inside the agent, so the id is resolved by `resolveInvestigationId`.
   */
  investigationId?: string;
};

// Same leniency as the wake schema, for the same reason.
export const watchInvestigateActionSchema = z.object({
  type: z.literal("watch.investigate"),
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
  resolution: z.enum(watchResolutions).optional(),
  observed: z.record(z.unknown()).optional(),
  note: z.string().optional(),
  investigationId: z.string().optional(),
});

/**
 * Every action the agent accepts. The union is the whole vocabulary: anything
 * else fails to parse and never reaches a handler.
 *
 * The trust boundary is the STREAM, not the schema. `.in` records are written
 * with an environment secret key or from the dashboard's own server-side hop,
 * and the `in` proxy refuses to forward a browser-supplied `trigger: "action"`.
 * So the model can describe an action but never place one, and a forged record
 * would carry no valid delegated token, leaving every read tool failed closed.
 */
export const dashboardAgentActionSchema = z.union([
  watchWakeActionSchema,
  watchInvestigateActionSchema,
]);

export type DashboardAgentAction = WatchWakeAction | WatchInvestigateAction;

// The per-wake framing only. How a wake is narrated lives in the managed system
// prompt's Watches section, which is the cached block.
const WAKE_INSTRUCTION =
  'A watch you set up earlier has resolved and reports once, right now — this is not a question, and nobody is waiting on a reply. Write ONE short message: what the watch found, the numbers from the facts below, and one suggested next step. Say what happened; never say the watch "fired" or "expired". A window that ran out with the condition still not true is an answer, not a failure. No tools, no new investigation, no recap.';

/**
 * Coerce replayed tool-call inputs the Anthropic API would reject back to `{}`.
 *
 * The model occasionally emits a no-arg tool call with a non-object input (an
 * empty string, or `null`, which `typeof` also calls "object"), the SDK replays it
 * into history verbatim, and the API then fails the whole turn with
 * "tool_use.input: Input should be an object".
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

/**
 * How the watch ended. The narration speaks resolution and observed outcome,
 * never "fired"/"expired" — those are the wire encoding, and a watch that ran its
 * whole window and found nothing has an answer to give, not a failure.
 *
 * Falls back to the transport when a wake predates the resolution model.
 */
function wakeResolution(action: WatchWakeAction): WatchResolution {
  if (action.resolution) return action.resolution;
  if (action.type === "watch.fired") return "condition_met";
  return (action.facts as { reason?: string } | undefined)?.reason === "terminal_unsatisfied"
    ? "condition_impossible"
    : "window_completed";
}

function wakeOutcome(action: WatchWakeAction): string {
  switch (wakeResolution(action)) {
    case "condition_met":
      return "the condition became true inside the window";
    case "condition_impossible":
      return "the condition can no longer become true — that is the answer, not a timeout";
    case "window_completed":
      // Deliberately not "nothing happened": "it didn't drain in an hour" is what
      // the user asked to be told.
      return "the window ran out with the condition still not true — this is the answer the user asked for, so report it plainly";
  }
}

/**
 * Whether this wake is the one the consent covers.
 *
 * Consent is for the ATTENTION outcomes only, and the contracts' resolved-result
 * mapping decides which those are per kind — no surface may substitute its own
 * judgement. Good news never starts anything, however the watch was configured.
 */
export function wakeStartsInvestigation(action: WatchWakeAction): boolean {
  if (action.investigateOnAttention !== true) return false;
  return watchResultNeedsAttention({
    kind: action.spec.kind,
    resolution: wakeResolution(action),
    outcome: action.observed as WatchObservedOutcome | undefined,
  });
}

/** The watched thing, as either action carries it. */
type WatchedSubject = { spec: WatchWakeAction["spec"]; identity: string };

/** The thing being watched, for the seeded investigation's own words. */
function wakeSubject(action: WatchedSubject): string {
  const spec = action.spec as Record<string, unknown>;
  for (const key of ["runId", "queue", "fingerprint", "report"]) {
    const value = spec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return action.identity || String(spec.kind ?? "this");
}

// The wake's line when the investigation is pre-approved. Phrased as a fact about
// this turn so the model can't turn it into an offer.
function investigationInstruction(action: WatchWakeAction): string {
  return `The user pre-approved an investigation for an outcome like this when they created the watch, and it has ALREADY been started for them — say so in one short clause, in the past tense, as part of your single message ("…I've started looking into why"). Never offer it, never ask, and don't describe what you'll check: you are conducting it right now and the findings land in your very next message, with the investigation card. Subject: ${wakeSubject(
    action
  )}.`;
}

/**
 * The watched object as a `trigger://` markdown link. The wake runs with no tools,
 * so the link has to be handed to it ready-made, which needs the tenancy from the
 * wake's metadata.
 */
function wakeSubjectLink(
  action: WatchedSubject,
  tenancy: { projectRef?: string; environmentId?: string } | undefined
): string | undefined {
  const projectRef = tenancy?.projectRef;
  const environmentId = tenancy?.environmentId;
  if (!projectRef || !environmentId) return undefined;

  const spec = action.spec;
  const target =
    "queue" in spec && spec.queue
      ? { kind: "queue" as const, projectRef, environmentId, name: spec.queue }
      : "runId" in spec && spec.runId
        ? { kind: "run" as const, projectRef, environmentId, runId: spec.runId }
        : "fingerprint" in spec && spec.fingerprint
          ? { kind: "error" as const, projectRef, environmentId, fingerprint: spec.fingerprint }
          : "report" in spec && spec.report
            ? { kind: "report" as const, projectRef, environmentId, key: spec.report }
            : undefined;
  if (!target) return undefined;

  const label =
    target.kind === "queue"
      ? target.name
      : target.kind === "run"
        ? target.runId
        : target.kind === "error"
          ? "this error"
          : "the report";
  return `[${label}](${formatTriggerUri(target)})`;
}

function wakePrompt(
  action: WatchWakeAction,
  tenancy?: { projectRef?: string; environmentId?: string }
): string {
  const subjectLink = wakeSubjectLink(action, tenancy);
  return [
    WAKE_INSTRUCTION,
    `Resolution: ${wakeResolution(action)} — ${wakeOutcome(action)}.`,
    `Watching: ${action.spec.kind}${action.identity ? ` (${action.identity})` : ""}.`,
    action.observed
      ? `What the final check observed:\n${JSON.stringify(action.observed, null, 2)}`
      : undefined,
    action.note ? `Why the user asked for it: ${action.note}` : undefined,
    `Facts from the check:\n${JSON.stringify(action.facts, null, 2)}`,
    subjectLink
      ? `When you point at the watched object, link it: ${subjectLink} — use this exact markdown link, not a bare name.`
      : undefined,
    wakeStartsInvestigation(action) ? investigationInstruction(action) : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Open the pre-approved investigation, the one relaxation of "never a new
 * investigation unprompted".
 *
 * Deliberately a seeded `in_progress` state and nothing more: the wake turn has no
 * delegated token to read with, so the findings arrive later in their own message.
 *
 * Runs after the narration is in the transcript and never throws, so a failure
 * here cannot delay, retry or invalidate the wake.
 */
async function openConsentedInvestigation(args: {
  action: WatchWakeAction;
  chatId: string;
  clientData: z.infer<typeof clientDataSchema> | undefined;
}): Promise<void> {
  const { action, chatId, clientData } = args;
  const projectRef = clientData?.projectRef;
  const environmentRef = clientData?.environmentId;
  if (!projectRef || !environmentRef) {
    // A watch created before the row carried the project's external ref. Scoping
    // it by the wrong identifier would strand the investigation, so skip it.
    logger.warn("dashboard-agent watch wake can't scope a consented investigation", {
      chatId,
      watchId: action.watchId,
    });
    return;
  }

  const subject = wakeSubject(action);
  const spec = action.spec as { runId?: unknown };
  try {
    const result = await getStore().upsertInvestigationRevision({
      chatId,
      projectRef,
      environmentRef,
      state: {
        outcome: "in_progress",
        severity: "warn",
        confidence: "low",
        title: `Investigating ${subject}`,
        headline: `The watch on ${subject} resolved to something that needs attention${
          action.note ? ` (${action.note})` : ""
        }. Looking into why.`,
        hypotheses: [],
        evidence: [],
        ...(typeof spec.runId === "string" ? { runId: spec.runId } : {}),
        startedAt: new Date().toISOString(),
      },
    });
    logger.info("dashboard-agent watch wake opened a consented investigation", {
      chatId,
      watchId: action.watchId,
      investigationId: result.ok ? result.id : undefined,
    });
  } catch (error) {
    // The wake is the delivery that matters; an investigation that couldn't be
    // opened is a lost follow-up, never a lost wake.
    logger.error("dashboard-agent watch wake failed to open its investigation", {
      chatId,
      watchId: action.watchId,
      error: (error as Error).message,
    });
  }
}

/**
 * Narrate one wake, exactly once.
 *
 * Streams so the panel shows it arriving live, then writes it to both `chat.history`
 * (the transcript the model sees next turn) and the display read-model. Both must
 * happen before `onAction` returns: `chat.history` mutations are only picked up
 * immediately after the hook.
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

  const resolved = await getSystemPrompt(modeFor(args.clientData));
  const result = streamText({
    model:
      locals.get(dashboardAgentModelKey) ??
      registry.languageModel(
        (resolved.model ?? "anthropic:claude-sonnet-4-6") as `anthropic:${string}`
      ),
    system: resolved.text,
    // No tools: a wake reports what the check already established, and carries no
    // delegated token to read with. The breakpoint goes on the last message of the
    // existing prefix, not on the unique wake, so the wake reads back the same
    // cached prefix a normal turn would instead of only writing cache.
    messages: [
      ...withCacheBreakpointOnLast(sanitizeReplayedToolInputs(args.messages)),
      {
        role: "user" as const,
        content: wakePrompt(action, {
          projectRef: args.clientData?.projectRef,
          environmentId: args.clientData?.environmentId,
        }),
      },
    ],
    ...resolved.toAISDKTelemetry(),
  });

  // Piped explicitly, rather than returned, so the final text is in hand for the
  // writes below. The streamed message must carry the SAME id the copy below is
  // persisted under: the panel merges live stream and loaded history by message
  // id, so two ids for one narration render it twice.
  await chat.pipe(result.toUIMessageStream({ generateMessageId: () => messageId }));
  const text = (await result.text).trim();
  if (!text) return;

  const message: UIMessage = {
    id: messageId,
    role: "assistant",
    parts: [{ type: "text", text }],
  };
  chat.history.set([...uiMessages, message]);
  // The display copy is an id-deduped append, never a wholesale write: a wake has
  // no client to carry the stored transcript, so the session view can miss
  // host-appended blocks (a card-born chat starts with only those) and
  // `persistMessages` would drop them.
  const userId = args.clientData?.userId;
  if (userId) {
    await getStore().appendMessage({ chatId, userId, message });
  } else {
    // A wake always carries its watch's tenancy, so reaching this means the
    // metadata contract broke. Deliver anyway: losing blocks beats losing the wake.
    logger.error("dashboard-agent watch wake has no userId; falling back to persistMessages", {
      chatId,
    });
    await getStore().persistMessages({ chatId, messages: [...uiMessages, message] });
  }

  // Only once the wake is in the transcript, so the investigation can never hold
  // the wake up.
  if (wakeStartsInvestigation(action)) {
    await openConsentedInvestigation({ action, chatId, clientData: args.clientData });
  }
}

/**
 * The turn's tool set: the read tools built from the delegated token this record's
 * metadata carried, plus the one narrow write the investigation executor needs.
 *
 * Shared by the agent's `tools` hook and the investigating turn below, so a
 * consented investigation reads with the same tools and the same scope a
 * user-driven one does.
 */
function buildTurnTools(
  chatId: string,
  clientData: z.infer<typeof clientDataSchema> | undefined
): ToolSet {
  return (
    locals.get(dashboardAgentToolsKey) ??
    buildDashboardAgentTools({
      ...(clientData ?? {}),
      chatId,
      investigations: {
        // Every committed revision is tracked, so the settle guard knows whether
        // the turn left a card running.
        upsert: async (params) => {
          const result = await getStore().upsertInvestigationRevision({ ...params, chatId });
          if (result.ok) trackInvestigationOutcome(chatId, result.id, params);
          return result;
        },
      },
    })
  );
}

// How far back the investigate action looks for the card the wake seeded. Wide
// enough to cover a slow wake turn, tight enough that an older abandoned card is
// never mistaken for this watch's.
const CONSENTED_INVESTIGATION_LOOKBACK_MS = 30 * 60 * 1000;

/**
 * The card this turn must revise: the sender's id when it has one, else the
 * freshest card this chat still has open — which is the one the wake seeded, since
 * `.in` records are handled in order — else a fresh seed for the wake whose seed
 * failed. All three exist to keep it to one card per consented outcome.
 */
async function resolveInvestigationId(args: {
  action: WatchInvestigateAction;
  chatId: string;
  projectRef: string;
  environmentRef: string;
}): Promise<string | undefined> {
  const { action, chatId, projectRef, environmentRef } = args;
  if (action.investigationId) return action.investigationId;

  const store = getStore();
  const open = await store.findOpenInvestigation({
    chatId,
    createdAfter: new Date(Date.now() - CONSENTED_INVESTIGATION_LOOKBACK_MS),
  });
  if (open) return open.id;

  const seeded = await store.upsertInvestigationRevision({
    chatId,
    projectRef,
    environmentRef,
    state: {
      outcome: "in_progress",
      severity: "warn",
      confidence: "low",
      title: `Investigating ${wakeSubject(action)}`,
      headline: `The watch on ${wakeSubject(action)} resolved to something that needs attention. Looking into why.`,
      hypotheses: [],
      evidence: [],
      startedAt: new Date().toISOString(),
    },
  });
  return seeded.ok ? seeded.id : undefined;
}

// The investigating turn's framing only. The protocol itself lives in the managed
// system prompt's Investigations section, which is the cached block.
function investigatePrompt(args: {
  action: WatchInvestigateAction;
  investigationId: string;
  tenancy: { projectRef?: string; environmentId?: string };
}): string {
  const { action, investigationId } = args;
  const subjectLink = wakeSubjectLink(action, args.tenancy);
  return [
    `Conduct the investigation the user pre-approved when they created this watch, right now, and finish it in this message. Nobody asked a question and nobody is waiting on a reply: your wake message has already told them the watch resolved and that you started looking into why, so this is the follow-up you promised — write it as its own message, and never re-narrate the wake.`,
    `The investigation is ALREADY OPEN as \`${investigationId}\`. Pass that exact investigationId to every render_view you make, so you revise that one card instead of opening a second. Your last tool call must be a render_view of it carrying a terminal outcome (concluded or inconclusive) — an investigation left at in_progress is an unfinished answer.`,
    `Subject: ${wakeSubject(action)} (${action.spec.kind}${
      action.identity ? `, ${action.identity}` : ""
    }).`,
    action.note ? `Why the user asked to be told: ${action.note}` : undefined,
    action.observed
      ? `What the resolving check observed:\n${JSON.stringify(action.observed, null, 2)}`
      : undefined,
    action.facts && Object.keys(action.facts).length > 0
      ? `Facts from that check — start from these rather than re-reading them:\n${JSON.stringify(
          action.facts,
          null,
          2
        )}`
      : undefined,
    subjectLink
      ? `When you point at the watched object, link it: ${subjectLink} — use this exact markdown link, not a bare name.`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Conduct the consented investigation, exactly once, as the agent's own message.
 *
 * A real turn in everything but name: same tools, same protocol, same step budget
 * `run()` gives. It is NOT a turn in the SDK's sense, so no `onTurnComplete` fires
 * — the settle guard runs here by hand and the message is appended id-deduped.
 *
 * The wake was delivered long before this, so everything here is best-effort and
 * nothing it does can retry or invalidate the wake.
 */
async function conductWatchInvestigation(args: {
  action: WatchInvestigateAction;
  chatId: string;
  clientData: z.infer<typeof clientDataSchema> | undefined;
  uiMessages: UIMessage[];
  messages: ModelMessage[];
}): Promise<void> {
  const { action, chatId, clientData, uiMessages } = args;
  const messageId = `investigate:${action.id}`;

  // Dedup on the action id, against the durable transcript — a redelivered kick
  // must not investigate (or answer) twice.
  if (uiMessages.some((message) => message.id === messageId)) {
    logger.info("dashboard-agent watch investigation already ran; skipping", {
      chatId,
      watchId: action.watchId,
      actionId: action.id,
    });
    return;
  }

  const projectRef = clientData?.projectRef;
  const environmentRef = clientData?.environmentId;
  if (!projectRef || !environmentRef) {
    // A card can't be scoped without the tenancy, and saying nothing beats a
    // findings message with nowhere to render.
    logger.error("dashboard-agent watch investigation can't be scoped; skipping", {
      chatId,
      watchId: action.watchId,
    });
    return;
  }

  const investigationId = await resolveInvestigationId({
    action,
    chatId,
    projectRef,
    environmentRef,
  });
  if (!investigationId) {
    logger.error("dashboard-agent watch investigation has no card to revise; skipping", {
      chatId,
      watchId: action.watchId,
    });
    return;
  }

  const store = getStore();
  const resolved = await getSystemPrompt(modeFor(clientData));
  const result = streamText({
    model:
      locals.get(dashboardAgentModelKey) ??
      registry.languageModel(
        (resolved.model ?? "anthropic:claude-sonnet-4-6") as `anthropic:${string}`
      ),
    system: resolved.text,
    tools: buildTurnTools(chatId, clientData),
    messages: [
      ...withCacheBreakpointOnLast(sanitizeReplayedToolInputs(args.messages)),
      {
        role: "user" as const,
        content: investigatePrompt({
          action,
          investigationId,
          tenancy: { projectRef, environmentId: environmentRef },
        }),
      },
    ],
    // The same budget a turn gets: four tool phases plus the answer.
    stopWhen: stepCountIs(10),
    ...resolved.toAISDKTelemetry(),
  });

  try {
    // Tee'd because the findings message has to be persisted whole: the panel
    // renders the card from the `render_view` tool part, so a text-only copy would
    // lose it on the next page load. One branch streams to the panel, the other
    // reduces the same chunks back into a UIMessage.
    const [toPanel, toTranscript] = result
      .toUIMessageStream({ generateMessageId: () => messageId })
      .tee();
    let response: UIMessage | undefined;
    const reduced = (async () => {
      for await (const snapshot of readUIMessageStream({ stream: toTranscript })) {
        response = snapshot;
      }
    })();
    await chat.pipe(toPanel);
    await reduced;

    if (response) {
      const message: UIMessage = { ...response, id: messageId, role: "assistant" };
      chat.history.set([...uiMessages, message]);
      const userId = clientData?.userId;
      if (userId) {
        await store.appendMessage({ chatId, userId, message });
      } else {
        logger.error("dashboard-agent watch investigation has no userId; skipping the append", {
          chatId,
        });
      }
    }
  } finally {
    // No `onTurnComplete` on an action, so the guard runs here: a card left at
    // in_progress is a spinner nothing else will ever stop.
    await settleOpenInvestigations(store, chatId);
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

  // Narrate the outcome, then conduct the investigation it opened when the user
  // consented. Each is one message deduped on the action id, and each returns void:
  // the stream is piped inside so the response reaches the history and read-model.
  onAction: async ({ action, chatId, clientData, uiMessages, messages }) => {
    const typed = action as DashboardAgentAction;
    if (typed.type === "watch.investigate") {
      await conductWatchInvestigation({ action: typed, chatId, clientData, uiMessages, messages });
      return;
    }
    await narrateWatchWake({ action: typed, chatId, clientData, uiMessages, messages });
  },

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
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
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
            toolActivity: extractToolActivity(newMessages),
          } satisfies EvalTurnPayload,
          { idempotencyKey: `eval:${chatId}:${turn}` }
        );
      } catch (error) {
        logger.error("Failed to enqueue dashboard-agent turn eval", { error });
      }
    }
  },

  // Roll a cache breakpoint onto the last message every turn so the growing
  // conversation prefix is cached and read back cheaply. Composes with the
  // system-block breakpoint above. chat.agent keeps the Head Start handover's
  // tool-approval tail intact across this hook, so it is safe on a resume turn.
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
      // toStreamTextOptions() defaults to a single step; override so the model can
      // call a tool and then answer from its result in the same turn.
      stopWhen: stepCountIs(10),
    });
  },
});
