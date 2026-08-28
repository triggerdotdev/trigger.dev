import { chat } from "@trigger.dev/sdk/ai";
import { locals, logger } from "@trigger.dev/sdk";
import {
  readUIMessageStream,
  stepCountIs,
  streamText,
  type ModelMessage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { z } from "zod";
import {
  forceSettledInvestigationState,
  formatTriggerUri,
  watchResolutions,
  watchResultNeedsAttention,
  type InvestigationState,
  type WatchObservedOutcome,
  type WatchResolution,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import { watchInvestigationId } from "@internal/dashboard-agent-db";
import {
  buildTurnTools,
  type clientDataSchema,
  type DashboardAgentStore,
  dashboardAgentModelKey,
  getStore,
  getSystemPrompt,
  modeFor,
  resolveDashboardAgentModel,
  latestCards,
  sanitizeReplayedToolInputs,
  clearOpenInvestigations,
  withCacheBreakpointOnLast,
} from "./agent-runtime";
import { planWatchNarration, type WatchNarrationPlan } from "./watch-narration";
import { recordPromptCacheUsage, stepCachePrepareStep } from "./step-cache";

/**
 * The watch lanes: the wake narration and the consented investigation that can
 * follow it. Both arrive as `.in` action records rather than turns, which is why
 * each does its own model call and its own persistence.
 */

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
    const result = await getStore().seedInvestigation({
      id: watchInvestigationId(action.watchId),
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
      error: result.ok ? undefined : result.error,
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
 * The narrating model, when there is one.
 *
 * Haiku gets the wake and nothing else: every number the sentence may use is in the
 * facts, and the deterministic headline is handed over as the opening fact so the
 * wording matches every other surface. Sonnet keeps the consented-investigation
 * wake, where the promise and the findings that follow must read as one voice — and
 * only there does the whole conversation come along.
 */
const HAIKU_WAKE_BRIEF =
  'You are the Trigger.dev dashboard agent, reporting on a watch the user asked you to keep. Write ONE short message, two sentences at most: the fact as given, then what it means for them and the single most useful next step. Never say the watch "fired" or "expired", never invent a number that isn\'t given, and don\'t recap the conversation — nobody is waiting on a reply.';

/**
 * A hard ceiling on that message, because "two sentences at most" is an instruction and
 * not a budget. Two sentences are well under 100 tokens, so this leaves plenty of room.
 */
const HAIKU_WAKE_MAX_OUTPUT_TOKENS = 300;

/** The fixed narration, as the panel's stream sees it. Same shape a model would emit. */
async function* fixedNarrationChunks(
  messageId: string,
  text: string
): AsyncGenerator<UIMessageChunk> {
  yield { type: "start", messageId };
  yield { type: "text-start", id: "wake" };
  yield { type: "text-delta", id: "wake", delta: text };
  yield { type: "text-end", id: "wake" };
  yield { type: "finish" };
}

/**
 * Stream the wake and return its final text.
 *
 * The streamed message must carry the SAME id the persisted copy uses: the panel
 * merges live stream and loaded history by message id, so two ids render it twice.
 */
async function narrateWithPlan(input: {
  plan: WatchNarrationPlan;
  action: WatchWakeAction;
  messageId: string;
  tenancy: { projectRef?: string; environmentId?: string };
  args: {
    clientData: z.infer<typeof clientDataSchema> | undefined;
    messages: ModelMessage[];
  };
}): Promise<string> {
  const { plan, action, messageId, tenancy, args } = input;

  if (plan.model === "none") {
    await chat.pipe(fixedNarrationChunks(messageId, plan.text));
    return plan.text;
  }

  const resolved = await getSystemPrompt(modeFor(args.clientData));
  const wake = wakePrompt(action, tenancy);
  const result =
    plan.model === "haiku"
      ? streamText({
          model:
            locals.get(dashboardAgentModelKey) ??
            resolveDashboardAgentModel("anthropic:claude-haiku-4-5"),
          system: HAIKU_WAKE_BRIEF,
          // Bounded on purpose: the wake alone, no conversation and no tools.
          messages: [
            {
              role: "user" as const,
              content: `${wake}\n\nOpen with this fact, in these words: ${plan.presentation.headline}.`,
            },
          ],
          maxOutputTokens: HAIKU_WAKE_MAX_OUTPUT_TOKENS,
        })
      : streamText({
          model:
            locals.get(dashboardAgentModelKey) ??
            resolveDashboardAgentModel(resolved.model ?? "anthropic:claude-sonnet-4-6"),
          system: resolved.text,
          // No tools: a wake reports what the check already established, and carries no
          // delegated token to read with. The breakpoint goes on the last message of the
          // existing prefix, not on the unique wake, so the wake reads back the same
          // cached prefix a normal turn would instead of only writing cache.
          messages: [
            ...withCacheBreakpointOnLast(sanitizeReplayedToolInputs(args.messages)),
            { role: "user" as const, content: wake },
          ],
          ...resolved.toAISDKTelemetry(),
        });

  await chat.pipe(result.toUIMessageStream({ generateMessageId: () => messageId }));
  return (await result.text).trim();
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
  const narrated = uiMessages.find((message) => message.id === messageId);
  if (narrated) {
    logger.info("dashboard-agent watch wake already narrated; repairing the display copy", {
      chatId,
      watchId: action.watchId,
      actionId: action.id,
    });
    // The streamed message is durable before the append is, so a retry can find the
    // wake narrated and the display copy still owed. The append is id-deduped, so
    // repairing when nothing is broken writes nothing.
    const userId = args.clientData?.userId;
    const organizationId = args.clientData?.organizationId;
    if (userId) {
      await getStore().appendMessage({ chatId, userId, organizationId, message: narrated });
    }
    return;
  }

  const tenancy = {
    projectRef: args.clientData?.projectRef,
    environmentId: args.clientData?.environmentId,
  };
  const plan: WatchNarrationPlan = planWatchNarration({
    kind: action.spec.kind,
    identity: action.identity,
    resolution: wakeResolution(action),
    observed: action.observed,
    note: action.note,
    subjectLink: wakeSubjectLink(action, tenancy),
    startsInvestigation: wakeStartsInvestigation(action),
  });
  logger.info("dashboard-agent watch wake narration lane", {
    chatId,
    watchId: action.watchId,
    kind: action.spec.kind,
    model: plan.model,
  });

  const text = await narrateWithPlan({ plan, action, messageId, tenancy, args });
  // Must throw: an unnarrated wake stays owed, so the retry says it again.
  if (!text) {
    throw new Error(`the wake narration for ${action.watchId} produced no text`);
  }

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
  const organizationId = args.clientData?.organizationId;
  if (userId) {
    await getStore().appendMessage({ chatId, userId, organizationId, message });
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
 * The card this turn must revise: the sender's id when it has one, else the watch's
 * own card, which the wake seeded under the same derived id. Seeding again is how a
 * wake whose seed failed still gets a card, and it can only ever open this watch's.
 */
async function resolveInvestigationId(args: {
  action: WatchInvestigateAction;
  chatId: string;
  projectRef: string;
  environmentRef: string;
}): Promise<string | undefined> {
  const { action, chatId, projectRef, environmentRef } = args;
  if (action.investigationId) return action.investigationId;

  const seeded = await getStore().seedInvestigation({
    id: watchInvestigationId(action.watchId),
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

/**
 * Close the card this lane opened: its terminal revision and the closing card in one
 * transaction, so a terminal row whose card never landed cannot exist.
 *
 * Only a deleted chat is swallowed. The row settles only if the card lands, and every other
 * failure has to reach the action for the task's retry to be a real retry.
 */
async function closeCardInTranscript(args: {
  store: DashboardAgentStore;
  chatId: string;
  investigationId: string;
  projectRef: string;
  environmentRef: string;
  messageId: string;
  uiMessages: UIMessage[];
  fallback: () => InvestigationState;
}): Promise<void> {
  const { store, chatId, investigationId, uiMessages } = args;

  if (uiMessages.some((message) => message.id === args.messageId)) return;

  const card = latestCards(uiMessages).get(investigationId);
  if (card && card.state && card.state.outcome !== "in_progress") return;

  // The lane's own message id, not the revision-stable one: a redelivered kick must
  // dedupe on the action, and this lane already checked for it above.
  const result = await store.settleInvestigationCard({
    id: investigationId,
    chatId,
    projectRef: args.projectRef,
    environmentRef: args.environmentRef,
    state: forceSettledInvestigationState(card?.state ?? args.fallback()),
    messageId: args.messageId,
  });
  if (!result.ok) {
    const message = "dashboard-agent watch investigation couldn't close its card";
    const details = { chatId, investigationId, error: result.error };
    // A chat deleted mid-investigation is a race, not a fault: nothing settled, and there
    // is no transcript left to close the card in.
    if (result.error === "chat_missing") {
      logger.warn(message, details);
      return;
    }
    logger.error(message, details);
    throw new Error(`${message}: ${result.error}`);
  }

  chat.history.set([...uiMessages, result.card as UIMessage]);
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
  const closingMessageId = `${messageId}:settled`;
  const projectRef = clientData?.projectRef;
  const environmentRef = clientData?.environmentId;

  const seedState = (): InvestigationState => ({
    outcome: "in_progress",
    severity: "warn",
    confidence: "low",
    title: `Investigating ${wakeSubject(action)}`,
    headline: `The watch on ${wakeSubject(action)} resolved to something that needs attention.`,
    hypotheses: [],
    evidence: [],
  });

  const closeCard = async (investigationId: string, messages: UIMessage[]) => {
    if (!projectRef || !environmentRef) return;
    await closeCardInTranscript({
      store: getStore(),
      chatId,
      investigationId,
      projectRef,
      environmentRef,
      messageId: closingMessageId,
      uiMessages: messages,
      fallback: seedState,
    });
  };

  // Dedup on the action id, against the durable transcript — a redelivered kick
  // must not investigate (or answer) twice.
  const alreadyAnswered = uiMessages.find((message) => message.id === messageId);
  if (alreadyAnswered) {
    logger.info("dashboard-agent watch investigation already ran; repairing the display copy", {
      chatId,
      watchId: action.watchId,
      actionId: action.id,
    });
    // Same window as the wake's: the findings streamed durably before the append, so a
    // retry can owe only the display copy. Id-deduped, so a repeat writes nothing.
    const userId = clientData?.userId;
    if (userId) {
      await getStore().appendMessage({
        chatId,
        userId,
        organizationId: clientData?.organizationId,
        message: alreadyAnswered,
      });
    }
    // This watch's card only: any other card still running belongs to the user or to
    // another watch, and closing it would answer a question nobody asked here.
    const cardId = action.investigationId ?? watchInvestigationId(action.watchId);
    const open = latestCards(uiMessages).get(cardId);
    if (open && (open.state === null || open.state.outcome === "in_progress")) {
      await closeCard(cardId, uiMessages);
    }
    return;
  }

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
  let answered: UIMessage | undefined;
  const resolved = await getSystemPrompt(modeFor(clientData));
  const tools = buildTurnTools(chatId, clientData);
  let step = 0;
  const result = streamText({
    model:
      locals.get(dashboardAgentModelKey) ??
      resolveDashboardAgentModel(resolved.model ?? "anthropic:claude-sonnet-4-6"),
    system: resolved.text,
    tools,
    // Ten steps of accumulating tool output is exactly what the rolling breakpoint
    // is for; without it every step re-sends the lot uncached.
    prepareStep: stepCachePrepareStep(undefined) as never,
    onStepFinish: (finished) =>
      recordPromptCacheUsage({
        source: "watch-investigation",
        usage: finished.usage,
        system: resolved.text,
        tools,
        step: step++,
        providerMetadata: finished.providerMetadata,
      }),
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
      answered = message;
      const userId = clientData?.userId;
      if (userId) {
        await store.appendMessage({
          chatId,
          userId,
          organizationId: clientData?.organizationId,
          message,
        });
      } else {
        logger.error("dashboard-agent watch investigation has no userId; skipping the append", {
          chatId,
        });
      }
    }
  } finally {
    // No `onTurnComplete` on an action, so the guard runs here: a card left at
    // in_progress is a spinner nothing else will ever stop. `closeCard` is the settle,
    // so nothing settles the row separately first.
    await closeCard(investigationId, answered ? [...uiMessages, answered] : uiMessages);
    // Only once the close committed: a retry needs the tracked entry to still be there.
    clearOpenInvestigations(chatId);
  }
}

/**
 * The agent's `onAction` lane, whole: narrate the outcome, then conduct the
 * investigation it opened when the user consented.
 */
export async function handleWatchAction(args: {
  action: unknown;
  chatId: string;
  clientData: z.infer<typeof clientDataSchema> | undefined;
  uiMessages: UIMessage[];
  messages: ModelMessage[];
}): Promise<void> {
  const { chatId, clientData, uiMessages, messages } = args;
  const typed = args.action as DashboardAgentAction;
  if (typed.type === "watch.investigate") {
    await conductWatchInvestigation({ action: typed, chatId, clientData, uiMessages, messages });
    return;
  }
  await narrateWatchWake({ action: typed, chatId, clientData, uiMessages, messages });
}
