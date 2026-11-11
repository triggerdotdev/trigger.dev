// If you add a `completeWaitpoint(` call site in the run-engine, add a matching
// entry here or `apps/webapp/test/crossSeamGuard.proof.test.ts` fails. Entries are
// one-per-textual-call-site (so the per-file count matches the source), anchored by
// method name, not line number. The `kind` is the dominant route kind — store
// selection is driven by residency, not kind, so a disputed kind label is cosmetic.
//
// PURE module — no engine import, no env, no Prisma.
import type { UnblockRouteKind } from "./types";

export interface UnblockRoute {
  id: string;
  kind: UnblockRouteKind;
  /** The relative source path, e.g. "internal-packages/run-engine/src/engine/index.ts". */
  site: string;
  /** Enclosing method/symbol name — NEVER a line number. */
  symbol: string;
}

const INDEX = "internal-packages/run-engine/src/engine/index.ts";
const WAITPOINT_SYSTEM = "internal-packages/run-engine/src/engine/systems/waitpointSystem.ts";
const TTL_SYSTEM = "internal-packages/run-engine/src/engine/systems/ttlSystem.ts";
const RUN_ATTEMPT_SYSTEM = "internal-packages/run-engine/src/engine/systems/runAttemptSystem.ts";

export const UNBLOCK_ROUTES: readonly UnblockRoute[] = [
  {
    id: "index.public",
    kind: "RESUME_TOKEN",
    site: INDEX,
    symbol: "completeWaitpoint (public declaration)",
  },
  {
    id: "index.public.delegate",
    kind: "RESUME_TOKEN",
    site: INDEX,
    symbol: "completeWaitpoint (delegation to waitpointSystem)",
  },
  {
    id: "index.finishWaitpoint",
    kind: "DATETIME",
    site: INDEX,
    symbol: "finishWaitpoint redis job (store routing enabled)",
  },
  {
    id: "index.finishWaitpoint.legacy",
    kind: "DATETIME",
    site: INDEX,
    symbol: "finishWaitpoint redis job (store routing disabled)",
  },
  {
    id: "wp.sink",
    kind: "RUN",
    site: WAITPOINT_SYSTEM,
    symbol: "completeWaitpoint (sink declaration)",
  },
  {
    id: "wp.completeLockedDateTime",
    kind: "DATETIME",
    site: WAITPOINT_SYSTEM,
    symbol: "completeWaitpoint (locked DATETIME re-entry)",
  },
  {
    id: "wp.ensureCompleted",
    kind: "RUN",
    site: WAITPOINT_SYSTEM,
    symbol: "ensureWaitpointCompleted (completion-guard redelivery)",
  },
  {
    id: "wp.recoverDateTime",
    kind: "DATETIME",
    site: WAITPOINT_SYSTEM,
    symbol: "recoverDateTimeWaitpoint (durable deadline completion)",
  },
  {
    id: "wp.recoverKeyedDateTime",
    kind: "DATETIME",
    site: WAITPOINT_SYSTEM,
    symbol: "recoverDateTimeWaitpoint (published keyed winner deadline completion)",
  },
  {
    id: "wp.blockAndComplete",
    kind: "RUN",
    site: WAITPOINT_SYSTEM,
    symbol: "blockRunAndCompleteWaitpoint",
  },
  {
    id: "wp.getOrCreate",
    kind: "IDEMPOTENCY_REUSE",
    site: WAITPOINT_SYSTEM,
    symbol: "getOrCreateRunWaitpoint",
  },
  {
    id: "wp.createAssociated",
    kind: "RUN",
    site: WAITPOINT_SYSTEM,
    symbol: "createAssociatedWaitpointRecord (native publication terminal reconciliation)",
  },
  {
    id: "wp.publishTerminalBatch",
    kind: "RUN",
    site: WAITPOINT_SYSTEM,
    symbol: "#publishNativeBatch (terminal publication reconciliation)",
  },
  {
    id: "wp.completeNativeBatch",
    kind: "RUN",
    site: WAITPOINT_SYSTEM,
    symbol: "completeBatchWaitpoint (native identity)",
  },
  {
    id: "batch.tryCompleteBatch",
    kind: "RUN",
    site: "internal-packages/run-engine/src/engine/systems/batchSystem.ts",
    symbol: "#resumeBatchParent (legacy identity)",
  },
  {
    id: "batch.expireBatch",
    kind: "RUN",
    site: "internal-packages/run-engine/src/engine/systems/batchSystem.ts",
    symbol: "expireBatch (legacy identity)",
  },
  {
    id: "ttl.expireRun",
    kind: "RUN",
    site: TTL_SYSTEM,
    symbol: "expireRun",
  },
  {
    id: "runAttempt.succeeded",
    kind: "RUN",
    site: RUN_ATTEMPT_SYSTEM,
    symbol: "attemptSucceeded",
  },
  {
    id: "runAttempt.cancel",
    kind: "RUN",
    site: RUN_ATTEMPT_SYSTEM,
    symbol: "cancelRun",
  },
  {
    id: "runAttempt.permanentlyFail",
    kind: "RUN",
    site: RUN_ATTEMPT_SYSTEM,
    symbol: "#permanentlyFailRun",
  },
  {
    id: "runAttempt.ensureFinalized",
    kind: "RUN",
    site: RUN_ATTEMPT_SYSTEM,
    symbol: "ensureRunFinalized",
  },
];

export function expectedCompleteWaitpointCallSites(): { site: string; symbol: string }[] {
  return UNBLOCK_ROUTES.map((r) => ({ site: r.site, symbol: r.symbol }));
}
