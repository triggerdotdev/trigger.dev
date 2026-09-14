import {
  createDashboardAgentDb,
  ensureChat,
  setChatTitleIfDefault,
  seedInvestigation,
  settleInvestigationStateAndCloseCard,
  settleTurnInvestigations,
  upsertInvestigationRevision,
  type ClosedInvestigationCard,
  type DashboardAgentDbClient,
  type PendingInvestigationSettlement,
  type SeedInvestigationResult,
  type SettleTurnInvestigationsResult,
  type UpsertInvestigationResult,
} from "@internal/dashboard-agent-db";
import type { TranscriptStorage } from "@trigger.dev/sdk/ai";
import { locals } from "@trigger.dev/sdk";
import { type LanguageModel, type ModelMessage, type ToolSet, type UIMessage } from "ai";
import { z } from "zod";
import {
  agentPageContextSchema,
  forceSettledInvestigationState,
  investigationStateSchema,
  type InvestigationState,
} from "@internal/dashboard-agent-contracts";
import { withCacheBreakpoint } from "./model-provider";
import { composeSystemPrompt, type DashboardAgentMode } from "./prompt-assembly";
import { codeSystemPrompt, systemPrompt, watchSystemPrompt } from "./prompts";
import { buildDashboardAgentTools } from "./tools";
import {
  dashboardAgentTranscriptStorage,
  type DashboardAgentTranscriptClientData,
} from "./transcript-storage";

/**
 * The agent's runtime: its datastore, the investigation bookkeeping every lane
 * shares, and the model, prompt and tool plumbing a turn is assembled from.
 *
 * Split out of `dashboard-agent.ts` so the turn lanes that are not the agent's
 * own hooks — the watch actions — can reach it without importing the agent back.
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
// models, against whichever provider is switched on.
export { resolveDashboardAgentModel } from "./model-provider";

// The agent's persistence, behind an interface so tests can inject a fake via
// `locals` and never need a real database.
export interface DashboardAgentStore {
  ensureChat(args: Parameters<typeof ensureChat>[1]): Promise<unknown>;
  /**
   * The conversation itself. `chat.agent` drives this: every message, the runtime's
   * state and the resume cursors reach the rows through it, and the panel reads the
   * same rows back.
   */
  transcript: TranscriptStorage<DashboardAgentTranscriptClientData>;
  /**
   * Close the investigations a turn left running: the terminal revisions and their
   * closing cards, in one transaction. The transcript is the runtime's to write; the
   * settlement has to commit with its card, and that is what this is for.
   */
  settleTurnInvestigations(
    args: Parameters<typeof settleTurnInvestigations>[1]
  ): Promise<SettleTurnInvestigationsResult>;
  setChatTitleIfDefault(args: Parameters<typeof setChatTitleIfDefault>[1]): Promise<unknown>;
  /** Commit one investigation revision. The only write the tool lane performs. */
  upsertInvestigationRevision(
    args: Parameters<typeof upsertInvestigationRevision>[1]
  ): Promise<UpsertInvestigationResult>;
  /**
   * Commit an investigation's terminal revision and its closing card together. The
   * lanes that have no `onTurnComplete` to hand settlements to write through this:
   * separately, a committed settle whose card failed is a terminal row the stale sweep
   * no longer selects, and a spinner nothing can stop.
   */
  settleInvestigationCard(
    args: Parameters<typeof settleInvestigationStateAndCloseCard>[1]
  ): Promise<ClosedInvestigationCard>;
  /**
   * Open an investigation under a caller-chosen id, or report it already open. A
   * consented watch's two lanes both name the row this way, so the second one revises
   * what the first opened instead of looking for the freshest open card.
   */
  seedInvestigation(
    args: Parameters<typeof seedInvestigation>[1]
  ): Promise<SeedInvestigationResult>;
}

export const dashboardAgentStoreKey = locals.create<DashboardAgentStore>("dashboard-agent.store");

/**
 * The `storage` handed to `chat.agent`. Resolved per call rather than once at module
 * load: the store (and in production its connection pool) is established inside the
 * run, and a test injects its own through `locals`.
 */
export const dashboardAgentStorage: TranscriptStorage<DashboardAgentTranscriptClientData> = {
  load: (scope, opts) => getStore().transcript.load(scope, opts),
  save: (ctx, changeset) => getStore().transcript.save(ctx, changeset),
};

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
 * Register an investigation an action seeded, so the turn that follows settles it if
 * the model leaves it running. The tool lane tracks what the model renders; a seeded
 * row the model never revises would otherwise be a spinner nothing closes.
 */
export function trackSeededInvestigation(
  chatId: string,
  id: string,
  params: { projectRef: string; environmentRef: string; state: unknown }
): void {
  trackInvestigationOutcome(chatId, id, params);
}

/**
 * The action turn in flight, set by `onAction` when it returns `chat.turn()` and read
 * by the turn's hooks: a wake turn runs without tools (it reports what the check
 * established and carries no delegated token), a wake the narration plan marks
 * `haiku` runs on the small model with a bounded budget, and neither kind is judged
 * by the eval. `onTurnStart` drops a marker the previous turn left behind, so a
 * settlement that failed on both attempts never taints the next typed turn.
 */
export const pendingActionTurnKey = locals.create<{
  kind: "wake" | "investigate";
  model?: "haiku";
}>("dashboard-agent.pendingActionTurn");

/**
 * Whatever this turn left `in_progress`, as the terminal states to close them with.
 * Nothing is written here: the caller hands these to `settleTurnInvestigations`, which
 * commits the rows and their closing cards in one transaction. Settling the row on its own
 * operation is what left terminal rows with an `in_progress` card — a state the stale
 * sweep no longer selects, so nothing ever repaired it.
 *
 * Read-only on purpose: `onTurnComplete` is retried, and a retry that found the entry
 * already dropped would settle nothing.
 */
export function pendingInvestigationSettlements(chatId: string): PendingInvestigationSettlement[] {
  const open = openInvestigations.get(chatId);
  if (!open || open.size === 0) return [];

  return [...open].map(([id, entry]) => ({
    id,
    projectRef: entry.projectRef,
    environmentRef: entry.environmentRef,
    state: forceSettledInvestigationState(entry.state),
  }));
}

/** Called once the settling write has committed, so the next turn starts clean. */
export function clearOpenInvestigations(chatId: string): void {
  openInvestigations.delete(chatId);
}

export type TranscriptCard = { id: string; revision: number; state: InvestigationState | null };

/** Both shapes the panel reads: a tool's output blocks, and a host-written view. */
function blocksInPart(part: unknown): unknown[] {
  const typed = part as {
    type?: string;
    output?: { blocks?: unknown[] };
    data?: { blocks?: unknown[] };
  };
  if (typed.type === "tool-render_view" && Array.isArray(typed.output?.blocks)) {
    return typed.output.blocks;
  }
  if (typed.type === "data-view" && Array.isArray(typed.data?.blocks)) return typed.data.blocks;
  return [];
}

function cardsInMessage(message: UIMessage): TranscriptCard[] {
  const found: TranscriptCard[] = [];
  for (const part of message.parts ?? []) {
    for (const block of blocksInPart(part)) {
      const candidate = block as { type?: string; id?: string; revision?: number };
      if (candidate?.type !== "investigation" || typeof candidate.id !== "string") continue;
      const parsed = investigationStateSchema.safeParse(
        (block as { investigation?: unknown }).investigation
      );
      found.push({
        id: candidate.id,
        revision: typeof candidate.revision === "number" ? candidate.revision : 0,
        state: parsed.success ? parsed.data : null,
      });
    }
  }
  return found;
}

/** Latest revision wins, the same way the panel resolves a card. */
export function latestCards(messages: UIMessage[]): Map<string, TranscriptCard> {
  const latest = new Map<string, TranscriptCard>();
  for (const message of messages) {
    for (const card of cardsInMessage(message)) {
      const current = latest.get(card.id);
      if (!current || card.revision >= current.revision) latest.set(card.id, card);
    }
  }
  return latest;
}

export function getStore(): DashboardAgentStore {
  const injected = locals.get(dashboardAgentStoreKey);
  if (injected) return injected;
  const { db } = getDb();
  return locals.set(dashboardAgentStoreKey, {
    ensureChat: (args) => ensureChat(db, args),
    transcript: dashboardAgentTranscriptStorage(db),
    settleTurnInvestigations: (args) => settleTurnInvestigations(db, args),
    setChatTitleIfDefault: (args) => setChatTitleIfDefault(db, args),
    upsertInvestigationRevision: (args) => upsertInvestigationRevision(db, args),
    settleInvestigationCard: (args) => settleInvestigationStateAndCloseCard(db, args),
    seedInvestigation: (args) => seedInvestigation(db, args),
  });
}

// Optional language-model override. Unset in production; tests inject a mock so
// `run()` and title generation never reach a provider.
export const dashboardAgentModelKey = locals.create<LanguageModel>("dashboard-agent.model");

// Optional tool-set override. Unset in production; tests and evals inject a
// fixture tool set (real schemas, stubbed executes).
export const dashboardAgentToolsKey = locals.create<ToolSet>("dashboard-agent.tools");

// The system prompt is dashboard-managed. Resolving it is an API call, so it is
// cached per worker process; workers are short-lived, so a dashboard edit lands
// within a recycle.

// The snapshot is fetched and extracted on the agent worker, so its URL must be one the
// server would have minted: plain https. The host check lives in repo-tools' fetch.
// Guarded at the schema edge too because old workers (the deployed version is pinned)
// can still replay metadata that carries a snapshot.
const repoSnapshotTarballUrlSchema = z.string().refine((value) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "tarballUrl must be an https URL");

// A turn is in `code` mode when the project has a connected repo. Drives both the
// tool set and the prompt.
export function modeFor(clientData: { repoSnapshot?: unknown } | undefined): DashboardAgentMode {
  return clientData?.repoSnapshot ? "code" : "assistant";
}

let cachedSystemPrompt: Awaited<ReturnType<typeof systemPrompt.resolve>> | undefined;
let cachedCodePrompt: Awaited<ReturnType<typeof codeSystemPrompt.resolve>> | undefined;
let cachedWatchPrompt: Awaited<ReturnType<typeof watchSystemPrompt.resolve>> | undefined;
export async function getSystemPrompt(
  mode: DashboardAgentMode = "assistant",
  options: { watchEnabled?: boolean } = {}
) {
  const base = await (async () => {
    if (mode === "code") {
      cachedCodePrompt ??= await codeSystemPrompt.resolve({});
      return cachedCodePrompt;
    }
    cachedSystemPrompt ??= await systemPrompt.resolve({});
    return cachedSystemPrompt;
  })();

  // The watch guidance is only shown when the turn actually has the watch tool,
  // so a turn without it never offers to tell the user later.
  if (!options.watchEnabled) return base;
  cachedWatchPrompt ??= await watchSystemPrompt.resolve({});
  return {
    ...base,
    // Both ids, so telemetry names the prompt the turn actually ran.
    promptId: `${base.promptId}+${cachedWatchPrompt.promptId}`,
    text: composeSystemPrompt(base.text, cachedWatchPrompt.text),
  };
}

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
  // Whether this turn may offer watches, resolved server-side. Defaults to off, so a
  // host that doesn't send it gets no watch tools and no watch guidance.
  watchEnabled: z.boolean().default(false),
  // Injected server-side by the `in` proxy each turn, never sent from the
  // browser: a short-lived read-only delegated token, the API origin to call
  // back to, and the project ref + env its tools read.
  userActorToken: z.string().optional(),
  apiOrigin: z.string().optional(),
  projectRef: z.string().optional(),
  environmentName: z.string().optional(),
  environmentBranch: z.string().optional(),
  // Injected only when the current project has a connected GitHub repo: a signed,
  // short-lived archive pointer the code-mode source tools read from.
  repoSnapshot: z
    .object({
      tarballUrl: repoSnapshotTarballUrlSchema,
      owner: z.string(),
      repo: z.string(),
      sha: z.string(),
      defaultBranch: z.string().optional(),
    })
    .optional(),
});

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

// Same breakpoint `prepareMessages` rolls onto a turn's last message.
export function withCacheBreakpointOnLast(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1]!;
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      // Merged, not replaced: the breakpoint is one provider option among any
      // others the message already carries.
      providerOptions: withCacheBreakpoint(last.providerOptions, "prefix"),
    },
  ];
}

/**
 * The turn's tool set: the read tools built from the delegated token this record's
 * metadata carried, plus the one narrow write the investigation executor needs.
 *
 * Shared by the agent's `tools` hook and the investigating turn below, so a
 * consented investigation reads with the same tools and the same scope a
 * user-driven one does.
 */
export function buildTurnTools(
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
