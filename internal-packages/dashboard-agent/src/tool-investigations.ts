import {
  INVESTIGATION_CAPABILITIES_VERSION,
  investigationBlockSchema,
  safeParseTriggerUri,
  VIEW_BLOCK_VERSION,
  WATCH_MAX_HOURS,
  type InvestigationAction,
  type InvestigationBlockBodyInput,
  type InvestigationCapabilities,
  type InvestigationState,
  type ViewBlockInput,
} from "@internal/dashboard-agent-contracts";
import { canonicalizeInvestigationState } from "./tool-evidence";
import type { SourceReadLookup } from "./tool-source-ledger";

/**
 * A capability rather than a database import, so this file stays reachable without
 * `@internal/dashboard-agent-db`. Without an `id` the store creates at revision 0.
 */
export type InvestigationsCapability = {
  upsert(params: {
    id?: string;
    projectRef: string;
    environmentRef: string;
    state: unknown;
  }): Promise<
    | { ok: true; id: string; revision: number; created: boolean }
    | { ok: false; error: "not_found" | "context_mismatch" }
  >;
};

/** What clicking "Show code" asks for. The eval sends this exact prompt. */
export function showCodeAskPrompt(args: { path: string; line: number; sha: string }): string {
  const shortSha = args.sha.slice(0, 7);
  return (
    `Propose a fix. Reply with one fenced \`\`\`diff block holding the minimal change, ` +
    `anchored to ${args.path}:${args.line}@${shortSha} — re-read that file at that commit if you need it. ` +
    `If ${shortSha} isn't the branch head, or that version was built from a dirty tree, say so in one line. ` +
    `Don't restate the investigation.`
  );
}

/** Defaults the "Watch for a repeat" card shows, which the user can change. */
const RECURRENCE_WATCH = { checkEveryMinutes: 15, maxHours: WATCH_MAX_HOURS } as const;

/**
 * The card's typed next actions, decided here and never by the model. "Show code"
 * needs a concluded card, a cited source line, and a read at that commit this turn.
 */
function investigationCapabilities(
  state: InvestigationState,
  reads: SourceReadLookup
): InvestigationCapabilities | null {
  if (state.outcome === "in_progress") return null;

  const cited = [...state.evidence, ...state.hypotheses.flatMap((h) => h.evidence)];
  const actions: InvestigationAction[] = [];

  if (state.outcome === "concluded") {
    for (const evidence of cited) {
      if (evidence.kind !== "source") continue;
      const parsed = safeParseTriggerUri(evidence.uri);
      if (!parsed.success || parsed.data.kind !== "source") continue;
      const { path, line, sha } = parsed.data;
      if (line === undefined) continue;
      if (!reads.wasReadThisTurn(path, sha)) continue;
      actions.push({
        kind: "show_code",
        label: "Show code",
        intent: { kind: "ask", prompt: showCodeAskPrompt({ path, line, sha }) },
      });
      break;
    }
  }

  if (state.outcome === "inconclusive") {
    actions.push({
      kind: "ask_follow_up",
      label: "Keep digging",
      intent: {
        kind: "ask",
        prompt: "Keep digging into this — what else can you check?",
      },
    });
  }

  const errorUri = cited.find((evidence) => evidence.kind === "error")?.uri;

  // "Watch for a repeat" needs a cited error fingerprint to pre-fill from, so without
  // one it is left off.
  const parsedError = errorUri ? safeParseTriggerUri(errorUri) : undefined;
  if (state.outcome === "concluded" && parsedError?.success && parsedError.data.kind === "error") {
    actions.push({
      kind: "watch_recurrence",
      label: "Watch for a repeat",
      intent: {
        kind: "watch",
        // A pre-fill only: emitting the spec creates nothing.
        spec: {
          kind: "error_recurrence",
          fingerprint: parsedError.data.fingerprint,
          checkEveryMinutes: RECURRENCE_WATCH.checkEveryMinutes,
          maxHours: RECURRENCE_WATCH.maxHours,
          note: `A repeat of: ${state.title}`,
        },
      },
    });
  }

  if (errorUri) {
    actions.push({
      kind: "view_similar",
      label: "View similar failures",
      intent: { kind: "navigate", target: errorUri },
    });
  }

  if (actions.length === 0) return null;
  return { version: INVESTIGATION_CAPABILITIES_VERSION, actions };
}

type InvestigationRenderResult =
  | { error: string }
  | { blocks: unknown[]; investigationId?: string; revision?: number };

export type InvestigationRenderer = (
  blocks: ViewBlockInput[],
  continueId?: string
) => Promise<InvestigationRenderResult>;

export type InvestigationRendererContext = {
  projectRef?: string;
  environmentId?: string;
  investigations?: InvestigationsCapability;
  reads: SourceReadLookup;
};

export function createInvestigationRenderer(
  ctx: InvestigationRendererContext
): InvestigationRenderer {
  const { projectRef, reads } = ctx;

  // Assigned by the store on the first investigation block and reused after that. Scoped
  // to the tool set, so the model only passes the id back across turns.
  let currentInvestigationId: string | undefined;

  /**
   * Commits a revision per investigation block, then stamps identity from what came
   * back. `continueId` is only a pointer; the turn's own closure wins when set.
   */
  return async function renderInvestigations(blocks: ViewBlockInput[], continueId?: string) {
    const investigationBlocks = blocks.filter((block) => block.type === "investigation").length;
    if (investigationBlocks === 0) return { blocks };

    // One id is assigned per call, so a second block in the same view would be written
    // as the next revision of the first: one card carrying two subjects.
    if (investigationBlocks > 1) {
      return {
        error:
          "A view holds at most one investigation block, and this one has more than one. Render one investigation per call, passing its own investigationId back each time.",
      };
    }

    if (!ctx.investigations) {
      return { error: "Investigations aren't available on this turn, so I can't render one." };
    }
    if (!projectRef || !ctx.environmentId) {
      return {
        error:
          "No current project and environment for this turn, so an investigation can't be scoped. Answer in prose instead.",
      };
    }

    const rendered: unknown[] = [];
    let investigationId: string | undefined;
    let revision: number | undefined;

    for (const block of blocks) {
      if (block.type !== "investigation") {
        rendered.push(block);
        continue;
      }

      // Canonical URIs are built before anything is stored or emitted, and a citation
      // that can't be canonicalized fails the call by name.
      let canonicalized: ReturnType<typeof canonicalizeInvestigationState>;
      try {
        canonicalized = canonicalizeInvestigationState(
          (block as InvestigationBlockBodyInput).investigation,
          { projectRef, environmentId: ctx.environmentId },
          reads
        );
      } catch (error) {
        return {
          error: `Couldn't cite that evidence: ${
            error instanceof Error ? error.message : "a citation was malformed"
          }. Fix or remove those citations and render again.`,
        };
      }
      if (canonicalized.errors.length > 0) {
        return {
          error: `Couldn't cite some of that evidence: ${canonicalized.errors.join(
            "; "
          )}. Fix or remove those citations and render again.`,
        };
      }
      const state = canonicalized.state;

      // A storage failure's message can carry the full SQL text, which must never reach
      // the transcript.
      let result: Awaited<ReturnType<InvestigationsCapability["upsert"]>>;
      try {
        result = await ctx.investigations.upsert({
          id: currentInvestigationId ?? continueId,
          projectRef,
          environmentRef: ctx.environmentId,
          state,
        });
      } catch (error) {
        console.error("investigation upsert failed", error);
        return {
          error:
            "Couldn't save the investigation right now. Say what you found in prose, honestly — if a card is already open it will be closed as inconclusive when the turn ends.",
        };
      }

      if (!result.ok) {
        // Nothing was written, so no card can be rendered.
        return {
          error:
            result.error === "context_mismatch"
              ? "That investigation belongs to a different chat, project, or environment, so it can't be updated here."
              : "That investigation no longer exists. Render again without an investigationId to start a new one.",
        };
      }

      currentInvestigationId = result.id;
      investigationId = result.id;
      revision = result.revision;

      const capabilities = investigationCapabilities(state, reads);

      const parsed = investigationBlockSchema.safeParse({
        ...block,
        investigation: state,
        ...(capabilities ? { capabilities } : {}),
        id: result.id,
        revision: result.revision,
        version: VIEW_BLOCK_VERSION,
      });
      if (!parsed.success) {
        return { error: "Couldn't render that investigation: the card payload didn't validate." };
      }
      rendered.push(parsed.data);
    }

    return { blocks: rendered, investigationId, revision };
  };
}
