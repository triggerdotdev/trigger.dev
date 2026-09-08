import {
  agentIntentSchema,
  watchSubjectLabel,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import { tool, type ToolSet } from "ai";
import { scheduleWatchSchema } from "./tool-schemas";
import type { DashboardAgentToolContext } from "./tool-context";
import { resolvedScopeFor } from "./tool-evidence";
import { bareFingerprint } from "./tool-read-scope";
import type { ScopedReadKind, SourceReadLookup } from "./tool-source-ledger";

/** The (kind, id) a watch spec's own object is read through the ledger by, or none
 * for a spec with no read-tracked identity. */
function scopedIdentityFor(
  spec: WatchSpec
): { kind: "run" | ScopedReadKind; id: string } | undefined {
  switch (spec.kind) {
    case "run_start":
    case "run_finished":
    case "run_failed":
      return { kind: "run", id: spec.runId };
    case "backlog_drain":
    case "queue_depth_above":
    case "queue_depth_below":
    case "queue_stalled":
    case "queue_oldest_age":
      return { kind: "queue", id: spec.queue };
    case "error_recurrence":
      return { kind: "error", id: bareFingerprint(spec.fingerprint) };
    case "health_recovery":
      return { kind: "report", id: spec.report };
    default:
      return undefined;
  }
}

/** The watch-facing tool set. Everything watch-specific the agent can call lives here. */
export function buildWatchTools(args: {
  ctx: DashboardAgentToolContext;
  reads?: SourceReadLookup;
}): ToolSet {
  const { ctx, reads } = args;

  return {
    // Proposes a watch, never creates one: the user confirming the card is what starts
    // it, so the card owns consent, the cap and dedup.
    schedule_watch: tool({
      ...scheduleWatchSchema,
      execute: async ({ watch }) => {
        // Watches are conversation-scoped in this slice, with no per-watch target — an
        // object read from another project/environment can't be watched silently under it.
        if (reads && ctx.projectRef && ctx.environmentId) {
          const identity = scopedIdentityFor(watch as WatchSpec);
          if (identity) {
            const base = { projectRef: ctx.projectRef, environmentId: ctx.environmentId };
            const here = `${base.projectRef}/${ctx.environmentName ?? base.environmentId}`;
            const neverRead =
              identity.kind === "run"
                ? reads.scopeForRun(identity.id) === undefined
                : reads.scopesForScopedRead(identity.kind, identity.id).length === 0;
            if (neverRead) {
              // Never read this turn: binding it to the current scope would be a guess.
              return {
                error: `${watchSubjectLabel(watch as WatchSpec)} hasn't been read this turn — look it up first (e.g. get_run, get_queue, get_error) before scheduling a watch for it.`,
              };
            }
            const resolved = resolvedScopeFor(identity.kind, identity.id, reads, base);
            if (!resolved.ok) {
              // Read from two or more scopes this turn, none of them this one: ambiguous.
              return {
                error: `${watchSubjectLabel(watch as WatchSpec)} was read from more than one project/environment this turn — I can only watch objects in ${here}.`,
              };
            }
            const elsewhere =
              resolved.scope.projectRef !== base.projectRef ||
              resolved.scope.environmentId !== base.environmentId
                ? resolved.scope
                : undefined;
            if (elsewhere) {
              const there = `${elsewhere.projectRef}/${elsewhere.environmentName ?? elsewhere.environmentId}`;
              return {
                error: `Watches are limited to the current project/environment (${here}) in this version; ${watchSubjectLabel(watch as WatchSpec)} lives in ${there}.`,
              };
            }
          }
        }
        // Re-validated through the intent schema, so a rejected spec becomes a tool
        // error rather than an intent the host drops.
        try {
          return { intent: agentIntentSchema.parse({ kind: "watch", spec: watch }) };
        } catch (error) {
          return { error: `Couldn't build that watch: ${(error as Error).message}` };
        }
      },
    }),
  };
}
