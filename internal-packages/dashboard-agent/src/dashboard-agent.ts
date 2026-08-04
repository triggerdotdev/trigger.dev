import { anthropic } from "@ai-sdk/anthropic";
import {
  appendChatMessageOnce,
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
  /**
   * Id-deduped single-message append. The wake narration writes through this
   * rather than `persistMessages`: a wake runs without a client, so the session's
   * view can miss host-appended blocks (the watch card's confirmation), and a
   * wholesale write would drop them.
   */
  appendMessage(args: Parameters<typeof appendChatMessageOnce>[1]): Promise<unknown>;
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

// ---------------------------------------------------------------------------
// The settle guard: a card left `in_progress` when the turn ends is a defect
// ---------------------------------------------------------------------------

/**
 * The investigations this turn left open, keyed by chat id.
 *
 * The prompt tells the model to render its verdict as the last tool call of the
 * turn, but a prompt is not a guarantee: the model can run out of steps, wander,
 * or have its verdict render rejected. Whatever the reason, the user is left
 * watching a spinner forever — the card is the persisted artifact, so an
 * `in_progress` row outlives the run that wrote it.
 *
 * So the executor tracks the outcome of every revision it commits, and settles
 * anything still open when the turn completes. Written by the `investigations`
 * capability below (the one seam the tool lane writes through), read and cleared
 * in `onTurnComplete`.
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
  // A terminal outcome (or a state we can't read) settles the entry: only a card
  // we know is still running is worth force-settling.
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
 * the same investigation (identity is fixed, revisions only climb).
 *
 * Best-effort: a failed settle must not fail the turn the user already got an
 * answer from, but it is logged, because a card stuck on a spinner is a defect
 * we want to see.
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

// Returns the injected store if a test seeded one, otherwise lazily builds the
// production store over the env-configured Drizzle client and caches it.
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

import {
  agentPageContextSchema,
  forceSettledInvestigationState,
  formatTriggerUri,
  investigationStateSchema,
  isWatchKind,
  resolveWatchResult,
  watchResolutions,
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
 *
 * `type` and `id` keep that two-value encoding on purpose (§7.5, binding): it is
 * the stable TRANSPORT, not the model. How the watch actually ended travels in
 * `resolution`, and what was observed when it did travels in `observed`.
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
  /** How the watch ended: met · window completed · impossible. */
  resolution?: WatchResolution;
  /** What was true when it ended — the run's final status, the depth, the count. */
  observed?: WatchObservedOutcome;
  /** Why the watch exists, in the user's words. */
  note?: string;
  /**
   * The user consented at creation to an investigation after an ATTENTION
   * outcome (§6). It relaxes exactly one rule — "never a new investigation
   * unprompted" — and only for that outcome.
   */
  investigateOnAttention?: boolean;
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
  // Lenient for the same reason `spec` is: a wake must never be lost to a
  // validation error. An older watcher that predates the resolution model simply
  // sends neither, and the narration falls back to the transport encoding.
  resolution: z.enum(watchResolutions).optional(),
  observed: z.record(z.unknown()).optional(),
  note: z.string().optional(),
  investigateOnAttention: z.boolean().optional(),
});

// The wake's own line. How a wake is narrated (once, briefly, outcome + facts +
// one suggestion) lives in the managed system prompt's "Watches" section, which
// is the cached block — this is only the per-wake framing.
const WAKE_INSTRUCTION =
  'A watch you set up earlier has resolved and reports once, right now — this is not a question, and nobody is waiting on a reply. Write ONE short message: what the watch found, the numbers from the facts below, and one suggested next step. Say what happened; never say the watch "fired" or "expired". A window that ran out with the condition still not true is an answer, not a failure. No tools, no new investigation, no recap.';

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

/**
 * How the watch ended, in the resolution model's own words.
 *
 * The narration speaks resolution + observed outcome, never "fired"/"expired":
 * those are the wire encoding (§7.5), and a watch that ran its whole window and
 * found nothing has an ANSWER to give, not a failure to apologise for.
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
      // Deliberately not "nothing happened": "it didn't drain in an hour" is
      // exactly the thing the user asked to be told.
      return "the window ran out with the condition still not true — this is the answer the user asked for, so report it plainly";
  }
}

/**
 * Whether THIS wake is the one the consent covers (§6, binding).
 *
 * Consent is for the ATTENTION outcomes only — the contracts' resolved-result
 * mapping decides which those are, per kind, and no surface may substitute its
 * own judgement. A drained queue and a quiet error group are good news and never
 * start anything, however the watch was configured.
 */
export function wakeStartsInvestigation(action: WatchWakeAction): boolean {
  if (action.investigateOnAttention !== true) return false;
  const kind = action.spec.kind;
  // A kind this build doesn't know has no mapping, so it has no category either.
  if (!isWatchKind(kind)) return false;
  const { category } = resolveWatchResult({
    kind,
    resolution: wakeResolution(action),
    outcome: action.observed as WatchObservedOutcome | undefined,
  });
  return category === "attention";
}

/** The thing being watched, for the seeded investigation's own words. */
function wakeSubject(action: WatchWakeAction): string {
  const spec = action.spec as Record<string, unknown>;
  for (const key of ["runId", "queue", "fingerprint", "report"]) {
    const value = spec[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return action.identity || String(spec.kind ?? "this");
}

// The wake's own line when the investigation is pre-approved. It states a fact
// about this turn — the investigation IS being opened here — so the model can't
// turn it into an offer, and the findings are explicitly somebody else's message.
function investigationInstruction(action: WatchWakeAction): string {
  return `The user pre-approved an investigation for an outcome like this when they created the watch, and it has ALREADY been started for them — say so in one short clause, in the past tense, as part of your single message ("…I've started looking into why"). Never offer it, never ask, and don't describe what you'll check: the findings arrive later, in their own message with the investigation card. Subject: ${wakeSubject(
    action
  )}.`;
}

/**
 * The watched object as a `trigger://` markdown link the narration can embed —
 * the wake runs with no tools, so the link has to be handed to it ready-made.
 * Needs the tenancy from the wake's metadata; without it there is no link.
 */
function wakeSubjectLink(
  action: WatchWakeAction,
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
 * Open the pre-approved investigation — the ONE relaxation of "never a new
 * investigation unprompted" (§6).
 *
 * It is deliberately a seeded `in_progress` state and nothing more: the wake
 * turn has no delegated token to read with, so it opens the thread and the
 * findings arrive later, in their own message with the card.
 *
 * Independence is the binding part (§6). This runs AFTER the narration is in the
 * transcript, it never throws, and the watcher has already marked the wake
 * delivered by the time the agent sees the action — so a failure here cannot
 * delay, retry or invalidate the wake.
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
    // it by the wrong identifier would strand the investigation, so skip it —
    // the wake itself already landed.
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
  // The session's view of the transcript, for the model's next turn.
  chat.history.set([...uiMessages, message]);
  // The display copy is an id-deduped APPEND, never a wholesale write: a wake
  // has no client to carry the stored transcript in, so the session view can
  // miss host-appended blocks (a card-born chat starts with ONLY those), and
  // `persistMessages` here would drop them.
  const userId = args.clientData?.userId;
  if (userId) {
    await getStore().appendMessage({ chatId, userId, message });
  } else {
    // A wake always carries its watch's tenancy; reaching this means the
    // metadata contract broke. Deliver anyway — losing blocks beats losing
    // the wake.
    logger.error("dashboard-agent watch wake has no userId; falling back to persistMessages", {
      chatId,
    });
    await getStore().persistMessages({ chatId, messages: [...uiMessages, message] });
  }

  // Only now, with the wake in the transcript: the investigation is the turn's
  // business after the banner exists, and it can never hold the banner up.
  if (wakeStartsInvestigation(action)) {
    await openConsentedInvestigation({ action, chatId, clientData: args.clientData });
  }
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
        // Every committed revision is also recorded here, so `onTurnComplete`
        // knows whether the turn left a card running (the settle guard above).
        upsert: async (params) => {
          const result = await getStore().upsertInvestigationRevision({ ...params, chatId });
          if (result.ok) trackInvestigationOutcome(chatId, result.id, params);
          return result;
        },
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

    // A card the turn left `in_progress` never settles on its own — the run is
    // over. Settle it to `inconclusive` before anything else, so a refresh right
    // after the turn can't read a spinner that will never stop.
    await settleOpenInvestigations(store, chatId);

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
