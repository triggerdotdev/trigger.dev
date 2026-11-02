import { createHash, randomUUID } from "node:crypto";
import { createRedisClient, type RedisClient, type RedisOptions } from "@internal/redis";
import type { Counter, Meter } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import pMap from "p-map";
import { completionFingerprint } from "./fanoutPolicy.js";
import {
  assertSingleSlot,
  edgeField,
  fanoutIndexKeys,
  fanoutPartition,
  FANOUT_PARTITION_COUNT,
  idempotencyKey,
  parseEdgeField,
  runBlockKeys,
  runContributionKey,
  runContributionIndexKey,
  runRegistrationSourcesKey,
  contributionMember,
  registrationEvidence,
  runWithdrawalKey,
  runWithdrawalTargetsKey,
  runResultKey,
  waitpointKeys,
  watcherField,
} from "./keys.js";
import {
  registerWaitpointCommands,
  RUN_CLEANUP_PAGE_SIZE,
  RETAIN_WAITPOINT_RECORD,
} from "./scripts.js";

/** The values written into a record's `status` field. Uppercase, and never a token. */
export type WaitpointStatus = "PENDING" | "COMPLETED";

/** Every script this coordinator may invoke. The wrapper below is the only entry point. */
type ScriptName =
  | "wpCreateIfAbsent"
  | "wpRegisterOrReport"
  | "wpComplete"
  | "wpFanoutClaim"
  | "wpFanoutAck"
  | "wpFanoutRelease"
  | "wpUnregisterWatcher"
  | "wpDescribe"
  | "wpIdemReserve"
  | "wpDiscard"
  | "wpFanoutIndex"
  | "runAbsorbBlockers"
  | "runDeliverCompletion"
  | "runMarkHandoffAcked"
  | "runTerminalCleanup"
  | "runReadBlockState"
  | "runClear"
  | "runAbandonRetainAndClear"
  | "runTerminalRetainAndClear"
  | "runArmCleanupFence"
  | "runReadCleanupFence"
  | "runClearCleanupFence"
  | "runFinalizeRetainedWithdrawal"
  | "runWithdrawalPage"
  | "runCompensateAbsorption"
  | "runDeleteContribution";

/**
 * The immutable half of a waitpoint, written once at creation. Carries every field the
 * legacy-shaped return types need, including the two that gate the executor-visible
 * idempotency key and the token surface.
 */
export type WaitpointRecordInput = {
  id: string;
  friendlyId: string;
  type: "RUN" | "BATCH" | "DATETIME" | "MANUAL";
  environmentId: string;
  projectId: string;
  createdAt: string;
  updatedAt: string;
  userProvidedIdempotencyKey: boolean;
  tags: string[];
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: string;
  completedAfter?: string;
  completedByTaskRunId?: string;
  completedByBatchId?: string;
};

/**
 * A stored output: a small inline value, an already-offloaded reference, or null when the
 * value is re-derivable from a business fact and is therefore never copied forward.
 */
export type WaitpointCompletionOutput = { inline: string } | { ref: string } | null;

/**
 * The completion half of a waitpoint, written at the flip.
 *
 * This is the coordinator's OWN type, deliberately not a projection of any frozen record
 * type. The store treats a completion as an opaque blob: it writes it, returns it, and
 * never inspects a field. Whoever owns the read-time resolver maps between this and the
 * frozen record shape, so the two can evolve without a type dependency in either
 * direction.
 */
export type WaitpointCompletion = {
  /** ISO 8601. */
  completedAt: string;
  outputType: string;
  outputIsError: boolean;
  output: WaitpointCompletionOutput;
};

/** A receipt may replace a source read only when it carries a complete, matching frozen record. */
function assertRetainedCompletion(
  receipt: WaitpointCompletion & { record?: WaitpointRecordInput },
  waitpointId: string
): asserts receipt is WaitpointCompletion & { record: WaitpointRecordInput } {
  const record = receipt.record;
  const parsed = parseWaitpointId(waitpointId);
  const output = receipt.output;
  if (
    !record ||
    parsed.format !== "b32hexW" ||
    record.id !== waitpointId ||
    record.type !== parsed.type ||
    typeof record.friendlyId !== "string" ||
    typeof record.environmentId !== "string" ||
    typeof record.projectId !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    typeof record.userProvidedIdempotencyKey !== "boolean" ||
    !Array.isArray(record.tags) ||
    !record.tags.every((tag) => typeof tag === "string") ||
    (record.type === "RUN" &&
      (typeof record.completedByTaskRunId !== "string" || !record.completedByTaskRunId)) ||
    typeof receipt.outputType !== "string" ||
    typeof receipt.outputIsError !== "boolean" ||
    !Number.isFinite(Date.parse(receipt.completedAt)) ||
    (output !== null &&
      (typeof output !== "object" ||
        !(
          ("inline" in output && typeof output.inline === "string") ||
          ("ref" in output && typeof output.ref === "string")
        )))
  ) {
    throw new Error(`Invalid retained completion for waitpoint ${waitpointId}`);
  }
  assertCompletionWithinLimits(receipt, "registerAndDeliver.retained");
}

/**
 * The largest inline completion output this coordinator will accept, in BYTES.
 *
 * Matched to `TASK_PAYLOAD_OFFLOAD_THRESHOLD`'s default (512 KiB), which is the threshold
 * `processWaitpointCompletionPacket` already offloads a waitpoint completion at: above it the
 * webapp uploads to the object store and hands back `application/store`, which is this type's
 * `{ ref }`. So this is not a new product limit — it is the existing boundary, asserted at the
 * store boundary so an unbounded string can never reach the synchronous work below.
 *
 * Deliberately a CONSTANT, not an option. The ceiling exists to keep `completionFingerprint`'s
 * hash and `JSON.stringify` off the event loop for an unbounded input, and a ceiling an operator
 * can raise is not a ceiling. An operator who raises the offload threshold above this gets
 * rejections here rather than a stalled event loop — see the report on this change.
 */
export const MAX_INLINE_COMPLETION_OUTPUT_BYTES = 524_288;

/**
 * The rest of the envelope, bounded from its own upstream contracts rather than by taste.
 *
 * A `{ ref }` exempts the referenced PAYLOAD, not the reference string: `output.ref` is itself an
 * unbounded string on this type, and it is fingerprinted and serialized like any other. Same for
 * the type and timestamp fields. Each bound below names where it comes from.
 */
const ENVELOPE_LIMITS = {
  /**
   * `output.ref` is the canonical storage URI `formatStorageUri` returns — `<protocol>://<key>`.
   * S3 and R2 both cap an object key at 1024 BYTES, which is the real contract; the extra 64 is
   * headroom for the short `s3://`-style prefix the URI carries on top of the key.
   */
  ref: 1_088,
  /**
   * `outputType` is a media type ("application/json", "application/super+json",
   * "application/store", "text/plain" — the longest in the repo is 33 characters). RFC 6838 caps
   * a media type's type name and subtype name at 127 characters each, so 255 covers any legal
   * value plus the separator with nothing to spare wasted.
   */
  outputType: 255,
  /** `completedAt` is documented as ISO 8601; the longest such form is well under this. */
  completedAt: 64,
  /**
   * A caller-supplied `completionId` is an opaque identity token, compared for equality and
   * stored in one hash field. The fallback this replaces is a SHA-256 hex digest (64 chars), so
   * 256 leaves room for a structured id without accepting a payload in the identity slot.
   */
  completionId: 256,
} as const;

/**
 * NOTE ON BLOCKER COUNT — deliberately unbounded here.
 *
 * An earlier revision capped this at 500, sourced from `MAX_BATCH_AND_WAIT_V2_TRIGGER_ITEMS`.
 * That was wrong: the variable is `z.coerce.number().int().default(500)` and is enforced only in
 * `api.v1.tasks.batch.ts` against `env.MAX_BATCH_AND_WAIT_V2_TRIGGER_ITEMS`, so an operator who
 * raises it would get an API that accepts a batch this coordinator then rejects. There is no
 * fixed product constant to anchor to, and inventing one here would put the limit in the wrong
 * layer.
 *
 * So `absorbBlockers` takes any number of edges, and the ARGV it builds grows with them. Bounding
 * it belongs with the wiring, alongside a shared product constant the API and the
 * store can both read. Recorded here so the exported surface's unboundedness is not a surprise.
 */

// A constant, not an option: this cleanup runs after the rollover has committed, so a
// caller-supplied value could throw inside pMap after the new block was installed.
const SUPERSEDED_CLEANUP_CONCURRENCY = 10;

// Bounds the concurrent per-id record reads a resume resolution issues. A resume reads one record
// per distinct store-resident blocker; this caps the fan-out so a wide wait cannot open an
// unbounded burst of Redis commands at once.
const RESOLVER_READ_CONCURRENCY = 20;

/** Thrown before any hashing, serialization or Redis call when a completion is too large. */
export class WaitpointCompletionTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
    readonly context: string
  ) {
    super(
      `Waitpoint completion output is ${bytes} bytes, over the ${limit}-byte inline limit ` +
        `(${context}). Offload it to the object store and pass { ref } instead.`
    );
    this.name = "WaitpointCompletionTooLargeError";
  }
}

/**
 * Reject an oversized inline completion output.
 *
 * Ordered so the expensive measurement is the one that cannot run away: UTF-8 byte length is
 * never LESS than code-unit length, so a string longer than the limit in units is over the limit
 * in bytes and is refused without measuring. `Buffer.byteLength` therefore only ever walks a
 * string already known to be at most the limit long.
 *
 * A `{ ref }` output is exempt by construction — it names an object-store key, whose size is a
 * property of the referenced payload and not of anything this process holds.
 */
function assertString(value: string, limit: number, field: string, context: string): void {
  // Same cheap ordering as the inline check: refuse on code units before measuring bytes.
  if (value.length > limit) {
    throw new WaitpointCompletionTooLargeError(value.length, limit, `${context}.${field}`);
  }
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > limit) {
    throw new WaitpointCompletionTooLargeError(bytes, limit, `${context}.${field}`);
  }
}

function assertCompletionWithinLimits(
  completion: WaitpointCompletion | undefined,
  context: string
): void {
  if (!completion) {
    return;
  }

  assertString(completion.outputType, ENVELOPE_LIMITS.outputType, "outputType", context);
  assertString(completion.completedAt, ENVELOPE_LIMITS.completedAt, "completedAt", context);

  const output = completion.output;
  if (!output) {
    return;
  }

  if ("ref" in output) {
    assertString(output.ref, ENVELOPE_LIMITS.ref, "output.ref", context);
    return;
  }

  if (output.inline.length > MAX_INLINE_COMPLETION_OUTPUT_BYTES) {
    throw new WaitpointCompletionTooLargeError(
      output.inline.length,
      MAX_INLINE_COMPLETION_OUTPUT_BYTES,
      context
    );
  }

  const bytes = Buffer.byteLength(output.inline, "utf8");
  if (bytes > MAX_INLINE_COMPLETION_OUTPUT_BYTES) {
    throw new WaitpointCompletionTooLargeError(bytes, MAX_INLINE_COMPLETION_OUTPUT_BYTES, context);
  }
}

/**
 * A completion that has been size-checked and serialized ONCE, for reuse across every delivery
 * made from one claimed fanout page.
 *
 * The envelope itself is unchanged: the same bytes are written to each run's receipt as before.
 * This only stops the worker re-running `JSON.stringify` per watcher, which for a wide page was
 * one full serialization of the completion per delivery.
 *
 * The empty string is the FINISHED-healing shape — COMPLETED with no envelope — exactly as
 * `deliverCompletion` has always encoded an absent completion.
 */
/**
 * The construction token. Module-private and never exported, so it cannot be reached from
 * outside this file even through a cast.
 *
 * `private constructor` alone is NOT enough: the modifier is erased, so
 * `new (EncodedWaitpointCompletion as any)(json, bytes)` produced a legitimate instance that
 * passed `isEncoded` while having skipped every size check. Requiring this token moves the
 * restriction from the type system into the runtime, where the guarantee has to hold.
 */
const ENCODED_CONSTRUCTOR_TOKEN = Symbol("waitpoint.encodedCompletion");

export class EncodedWaitpointCompletion {
  // The private field keeps object literals from satisfying the type at compile time; the token
  // below keeps a cast from manufacturing one at runtime. Both are needed: neither alone closes
  // the path that `deliverEncodedCompletion` relies on.
  readonly #validated = true;

  private constructor(
    token: symbol,
    readonly json: string,
    /** Measured once here, so the delivery budget never re-walks the string per page. */
    readonly bytes: number
  ) {
    if (token !== ENCODED_CONSTRUCTOR_TOKEN) {
      throw new TypeError(
        "EncodedWaitpointCompletion cannot be constructed directly; use encodeCompletionForDelivery"
      );
    }
  }

  /** The ONLY way to obtain one. Validates, then serializes exactly once. */
  static encode(
    completion: WaitpointCompletion | undefined,
    context: string,
    record?: WaitpointRecordInput
  ): EncodedWaitpointCompletion {
    assertCompletionWithinLimits(completion, context);
    const json = completion ? JSON.stringify(record ? { ...completion, record } : completion) : "";
    return new EncodedWaitpointCompletion(
      ENCODED_CONSTRUCTOR_TOKEN,
      json,
      Buffer.byteLength(json, "utf8")
    );
  }

  /** Cheap, non-forgeable check for the delivery boundary. */
  static isEncoded(value: unknown): value is EncodedWaitpointCompletion {
    return value instanceof EncodedWaitpointCompletion && value.#validated;
  }
}

export function encodeCompletionForDelivery(
  completion: WaitpointCompletion | undefined,
  context: string,
  record?: WaitpointRecordInput
): EncodedWaitpointCompletion {
  return EncodedWaitpointCompletion.encode(completion, context, record);
}

/**
 * One store-resident waitpoint as {@link WaitpointStoreCoordinator.readCompletedRecords} returns it.
 * The completion stays the coordinator's OWN opaque {@link WaitpointCompletion}; the resolver, not the
 * store, maps it to the frozen TRES record shape.
 */
export type WaitpointStoredRecord = {
  status: WaitpointStatus;
  record: WaitpointRecordInput;
  completion?: WaitpointCompletion;
};

export type WatcherEntry = {
  runId: string;
  /**
   * The block operation the watcher registered under, carried so that fanout delivery can
   * be refused on a run that has since moved on. See `deliverCompletion`.
   */
  blockId: string;
  batchIndex?: number;
  spanIdToComplete?: string;
  createdAt: string;
  /**
   * The watching run's organization. The explicit slot for the asynchronous fanout to carry the same
   * value the inline path threads through `BlockedRun`, so a fanout-driven continuation can route
   * MemoryDB by the run's own org instead of reaching the predicate with an unknown org. Optional and
   * unused by this layer; the blocker-registration migration populates it.
   */
  organizationId?: string;
};

export type CreateIfAbsentResult =
  | { outcome: "created" }
  | {
      outcome: "exists";
      record: WaitpointRecordInput;
      status: WaitpointStatus;
      completion?: WaitpointCompletion;
    };

export type RegisterOrReportResult =
  | { outcome: "registered" }
  | {
      outcome: "completed";
      completion?: WaitpointCompletion;
      record?: WaitpointRecordInput;
      /** The completing run's id (record `cbt`), returned ATOMICALLY with the envelope for cachedRunId. */
      completedByTaskRunId?: string;
    };

/** The lifecycle of a waitpoint's fanout obligation. `absent` means none was ever owed. */
export type FanoutState = "absent" | "pending" | "done" | "quarantined";

export type CompleteResult = {
  outcome: "completed" | "already";
  completion?: WaitpointCompletion;
  /**
   * What the completion left behind. `pending` means a durable fanout entry now exists and
   * a worker owes the watchers a delivery; `absent` means there were none and the record is
   * already terminal.
   */
  fanout: FanoutState;
};

/**
 * One run-to-waitpoint edge. The metadata a frozen return type — an existing API response
 * shape this store must keep reproducing — needs travels here.
 */
export type BlockEdge = {
  waitpointId: string;
  batchIndex?: number | null;
  batchId?: string;
  spanIdToComplete?: string;
  createdAt: string;
  type: WaitpointRecordInput["type"];
  completedAfter?: string;
  // Set when a source read or register step reported this waitpoint COMPLETED. The box, not
  // `completion`, carries the "reported" fact: box present + no completion means
  // COMPLETED-with-no-envelope, box absent means never reported.
  reported?: { completion?: WaitpointCompletion & { record?: WaitpointRecordInput } };
};

export type AbsorbResult = {
  /**
   * `absorbed` is the only outcome that installed anything. `stale` means the run has moved
   * on to a block this operation did not expect; `terminal` means it has been through
   * cleanup. Both mutated nothing, and neither may proceed to registration.
   */
  outcome: "absorbed" | "stale" | "terminal" | "cleanupOwed";
  /** The block the run is actually on, for diagnosing a refusal. */
  currentBlockId?: string;
  /**
   * How many DISTINCT requested ids were still pending. Equivalent to the count the
   * previous path took over this call's ids, which was a COUNT over waitpoint rows — so
   * two edges for one waitpoint contribute one. This is the number a caller should use to
   * keep today's block-time gate unchanged.
   */
  pendingOfRequested: number;
  /**
   * The run's whole pending set, counting STORE-RESIDENT blockers only. A run can also be
   * blocked by a legacy waitpoint, which this number cannot see, so it is never on its own
   * a decision to resume.
   */
  storePendingTotal: number;
  alreadyDelivered: Array<{
    waitpointId: string;
    completion?: WaitpointCompletion & { record?: WaitpointRecordInput };
  }>;
  /**
   * What the rollover did about the SUPERSEDED cycle's watcher registrations, when this call
   * replaced one. Absent when nothing was superseded — a first block, or a same-block retry.
   *
   * Reported rather than thrown: a cleanup failure must not invalidate the block this call
   * just installed, so the caller gets the block AND the residue.
   */
  supersededCleanup?: SupersededCleanup;
  /**
   * Cached spans closed by an early/racing delivery during registerAndDeliver, for the caller to emit as
   * cachedRunCompleted. Empty from a bare absorb (delivery is registration's job). Shape matches the
   * contract layer's CachedSpanCompletion; kept inline so this low-level module stays free of that import.
   */
  cachedSpanCompletions?: Array<{
    spanId: string;
    spanCreatedAt: string;
    blockedRunId: string;
    hasError: boolean;
    cachedRunId?: string;
  }>;
};

export type SupersededCleanup = {
  /** The block operation whose registrations were withdrawn. */
  blockId: string;
  /** Registrations this call withdrew, or found already gone — both are success. */
  withdrawn: number;
  /**
   * Registrations that could not be withdrawn, with the waitpoint each names. NON-EMPTY means
   * reconciliation residue: the block is correctly installed, but these waitpoint shards still
   * carry a registration under the superseded block id. Reconciliation repairs them.
   */
  failed: Array<{ waitpointId: string; batchIndex?: number; error: string }>;
};

// absorbBlockers strips `reported` before writing the edge blob, so a value read back
// here can never carry it — Omit says so instead of inheriting a field that is always
// undefined.
export type BlockStateEdge = Omit<BlockEdge, "reported"> & { edgeId: string };

/** Whether the run owes TRES a durable resume transition for its current block. */
export type HandoffState = "none" | "owed" | "acked";

export type BlockState = {
  pendingIds: string[];
  deliveredIds: string[];
  edges: BlockStateEdge[];
  /** The current block operation, or undefined when nothing has been absorbed. */
  blockId?: string;
  handoff: HandoffState;
  /** True once terminal cleanup has run, after which delivery is refused. */
  terminal: boolean;
};

export type DeliverResult = {
  outcome: "delivered" | "duplicate" | "stale" | "terminal" | "acked";
  storePendingTotal: number;
  /** True only when this delivery emptied the CURRENT block's pending set. */
  resumable: boolean;
  /** The block id the run is actually on, for diagnosing a stale delivery. */
  currentBlockId?: string;
};

/** One watcher handed back by a claimed fanout page, in queue order. */
export type FanoutPageEntry = {
  field: string;
  /** Undefined when the registration has been withdrawn since it was queued. */
  watcher?: WatcherEntry;
};

export type FanoutClaim =
  /**
   * No fanout entry, and the record says the hint that led here is safe to retire.
   * `no-record` — nothing under that id at all. `completed` — completed owing nothing, or
   * drained long enough ago that its entry has expired.
   */
  | { outcome: "absent"; reason: "no-record" | "completed" }
  /**
   * No fanout entry, but the record is still PENDING, so a completion may have filed this
   * hint and not yet flipped. The hint must survive — see `wpFanoutClaim`.
   */
  | { outcome: "pending-record" }
  /** Backing off. `notBefore` is the authoritative earliest claim time, in epoch ms. */
  | { outcome: "notdue"; notBefore: number }
  | { outcome: "done" }
  | { outcome: "quarantined"; failures: number }
  | { outcome: "busy"; owner: string; leaseExpiresAt: number }
  | {
      outcome: "claimed";
      completion?: WaitpointCompletion;
      /** True when this claim took the entry off a worker whose lease had lapsed. */
      reclaimed: boolean;
      /** Claims taken on this entry. A diagnostic — it counts pages, not failures. */
      attempts: number;
      /**
       * The fence token for THIS claim. Every later transition for it — the acknowledgement
       * and the failed release — must quote it, which is what makes those transitions safe
       * to replay and what refuses them once the claim has been superseded.
       */
      epoch: string;
      /** Consecutive failures, which any progress resets. The give-up threshold's input. */
      failures: number;
      /** Completion time in epoch ms, for the completion-to-delivery latency signal. */
      completedAtMs: number;
      /**
       * The waitpoint record's `completedByTaskRunId`, carried once per claimed page so cached-span
       * completion can supply it as `cachedRunId` without a per-watcher record read. Undefined when the
       * record does not carry it.
       */
      completedByTaskRunId?: string;
      record?: WaitpointRecordInput;
      page: FanoutPageEntry[];
    };

export type FanoutAckResult =
  | { outcome: "absent" }
  | { outcome: "lost"; owner: string }
  | { outcome: "more"; remaining: number }
  | { outcome: "drained"; delivered: number };

/**
 * Why a claim is being given back.
 *
 * `yield` is the visit's page budget running out with work left, which is not a failure.
 * `fail` increments the consecutive-failure streak AND, atomically, quarantines the entry
 * once that streak reaches the policy's `maxFailures`.
 */
export type FanoutReleaseAction = "yield" | "fail";

export type FanoutReleaseResult =
  | { outcome: "absent" }
  | { outcome: "lost"; owner: string }
  | {
      outcome: "released" | "quarantined";
      failures: number;
      /** The authoritative earliest next claim time the script computed and stored. */
      notBefore: number;
    };

export type WaitpointDiagnostics =
  | { outcome: "missing" }
  | {
      outcome: "exists";
      status: WaitpointStatus;
      /** Milliseconds until the record expires; -1 when it has no TTL. */
      recordTtlMs: number;
      liveWatchers: number;
      queuedWatchers: number;
      fanout: FanoutState;
      fanoutOwner?: string;
      fanoutLeaseExpiresAt: number;
      fanoutAttempts: number;
      fanoutFailures: number;
      completedAtMs: number;
      delivered: number;
    };

export type FanoutBacklog = {
  due: number;
  /** Epoch ms of the oldest due entry, or undefined when the index is empty. */
  oldestDueAtMs?: number;
  quarantined: number;
};

/**
 * Why a run's coordination state is being reclaimed.
 *
 * `resume` respects an outstanding handoff obligation and refuses. `cancelled` and
 * `terminal` discharge it: a run in either state will never publish a resume transition,
 * so there is nothing left to wait for.
 */
export type CleanupReason = "resume" | "cancelled" | "terminal";

export type CleanupResult =
  | {
      outcome: "armed";
      handoffWas: HandoffState;
      /** `absent` means the run had no coordination state, so nothing was written. */
      state: "present" | "absent";
    }
  | { outcome: "retained"; reason: "handoff-owed" };

export class WaitpointNotFoundError extends Error {
  constructor(waitpointId: string) {
    super(`Waitpoint ${waitpointId} is not present in the store`);
    this.name = "WaitpointNotFoundError";
  }
}

/**
 * A second, non-equivalent completion for an already-completed waitpoint.
 *
 * Thrown rather than returned. The stored envelope is immutable and has already been
 * delivered, so there is no correct way for a caller to carry on; the design's required
 * behaviour is to fail loudly and quarantine or alert.
 */
export class WaitpointCompletionConflictError extends Error {
  readonly waitpointId: string;
  readonly storedCompletionId: string;
  readonly incomingCompletionId: string;
  readonly storedCompletion?: WaitpointCompletion;

  constructor(args: {
    waitpointId: string;
    storedCompletionId: string;
    incomingCompletionId: string;
    storedCompletion?: WaitpointCompletion;
  }) {
    super(
      `Waitpoint ${args.waitpointId} is already completed with a different completion ` +
        `(stored ${args.storedCompletionId}, incoming ${args.incomingCompletionId})`
    );
    this.name = "WaitpointCompletionConflictError";
    this.waitpointId = args.waitpointId;
    this.storedCompletionId = args.storedCompletionId;
    this.incomingCompletionId = args.incomingCompletionId;
    this.storedCompletion = args.storedCompletion;
  }
}

/**
 * How long a terminal record and a reclaimed run partition are retained. Longer than the default
 * TRES completed TTL (4 days, `RUN_ENGINE_SNAPSHOT_STORE_COMPLETED_TTL_MS`), so a resume that can
 * still read its snapshots also finds this record.
 */
export const DEFAULT_TERMINAL_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

export type WaitpointStoreCoordinatorOptions = {
  redisOptions?: RedisOptions;
  /** App-owned standalone or MemoryDB cluster client. No eager connection is required. */
  client?: RedisClient;
  /** Connect and validate infrastructure before commands; inert until a store operation. */
  beforeCommand?: () => Promise<void>;
  logger?: Logger;
  meter?: Meter;
  /** Defaults to {@link DEFAULT_TERMINAL_RETENTION_MS}. */
  terminalRetentionMs?: number;
  /** Injectable so a test can assert lease and backoff arithmetic without waiting. */
  clock?: () => number;
};

// Lua returns '' for an absent value, never nil, because every reply slot is coerced to
// keep the array from truncating. So a nullish check would not fire and JSON.parse('')
// throws. One helper, used at every decode site.
function parseJson<T>(raw: string | undefined): T | undefined {
  return raw ? (JSON.parse(raw) as T) : undefined;
}

function decodeFanoutState(raw: string | undefined): FanoutState {
  switch (raw) {
    case "pending":
    case "done":
    case "quarantined":
      return raw;
    default:
      return "absent";
  }
}

function decodeHandoff(raw: string | undefined): HandoffState {
  switch (raw) {
    case "owed":
      return "owed";
    case "ack":
      return "acked";
    default:
      return "none";
  }
}

export class WaitpointStoreCoordinator {
  private readonly redis: RedisClient;
  private readonly beforeCommand?: () => Promise<void>;
  private readonly ownsClient: boolean;
  private readonly logger: Logger;
  private readonly terminalRetentionMs: number;
  private readonly clock: () => number;
  private readonly metrics: {
    completions?: Counter;
    conflicts?: Counter;
    registrations?: Counter;
    deliveries?: Counter;
    watchersUnregistered?: Counter;
    supersededWatcherCleanupFailures?: Counter;
    staleAbsorbs?: Counter;
    cleanups?: Counter;
  } = {};
  #quit?: Promise<void>;

  constructor(options: WaitpointStoreCoordinatorOptions) {
    this.logger = options.logger ?? new Logger("WaitpointStoreCoordinator", "debug");
    this.terminalRetentionMs = options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.clock = options.clock ?? Date.now;
    if (!options.client && !options.redisOptions) {
      throw new Error("Waitpoint store requires a Redis client or connection options");
    }
    this.beforeCommand = options.beforeCommand;
    this.ownsClient = !options.client;
    this.redis =
      options.client ??
      createRedisClient(options.redisOptions!, {
        onError: (error) =>
          this.logger.error("WaitpointStoreCoordinator redis client error", { error }),
      });
    registerWaitpointCommands(this.redis);

    if (options.meter) {
      this.#initializeMetrics(options.meter);
    }
  }

  #initializeMetrics(meter: Meter): void {
    this.metrics.completions = meter.createCounter("waitpoint.store.completions", {
      description: "Waitpoint completions by outcome and resulting fanout state",
    });
    this.metrics.conflicts = meter.createCounter("waitpoint.store.completion_conflicts", {
      description: "Second, non-equivalent completions rejected for an already-completed waitpoint",
    });
    this.metrics.registrations = meter.createCounter("waitpoint.store.registrations", {
      description: "Watcher registrations by outcome (registered, or reported complete inline)",
    });
    this.metrics.deliveries = meter.createCounter("waitpoint.store.run_deliveries", {
      description: "Run-side completion deliveries by outcome",
    });
    this.metrics.watchersUnregistered = meter.createCounter(
      "waitpoint.store.watchers_unregistered",
      {
        description: "Watcher registrations withdrawn on cancellation or terminal completion",
      }
    );
    this.metrics.supersededWatcherCleanupFailures = meter.createCounter(
      "waitpoint.store.superseded_watcher_cleanup_failures",
      {
        description:
          "Superseded-block watcher registrations a rollover could not withdraw. Non-zero means " +
          "reconciliation residue on the named waitpoint shards.",
      }
    );
    this.metrics.staleAbsorbs = meter.createCounter("waitpoint.store.stale_absorbs", {
      description: "Block absorptions refused by the compare-and-set, by outcome",
    });
    this.metrics.cleanups = meter.createCounter("waitpoint.store.run_cleanups", {
      description: "Run coordination cleanups by reason and outcome",
    });
  }

  // Idempotent and error-swallowing: every test calls this in a finally, and a double quit
  // must never mask the real assertion failure.
  async quit(): Promise<void> {
    if (!this.ownsClient) return;
    if (this.redis.status === "wait" || this.redis.status === "end") {
      this.redis.disconnect();
      return;
    }
    if (!this.#quit) {
      this.#quit = this.redis.quit().then(
        () => undefined,
        () => undefined
      );
    }
    await this.#quit;
  }

  /**
   * The ONLY way this class invokes a script. Routing every call through one place is what
   * makes the single-slot guard un-forgettable: a method added later cannot reach a script
   * without passing its keys through this assertion.
   *
   * Every script's signature is (...keys, ...argv) => string[], so one cast covers them
   * all. The typed RedisCommander augmentation in scripts.ts documents each shape.
   */
  #call(script: ScriptName, keys: string[], ...argv: string[]): Promise<string[]> {
    assertSingleSlot(script, keys);
    // Each read-affecting mutation gets a fresh epoch, including retries of a logical operation.
    // Delivery initializes the epoch only; its immutable receipt ordinal preserves an ongoing read.
    if (
      [
        "runAbsorbBlockers",
        "runDeliverCompletion",
        "runMarkHandoffAcked",
        "runTerminalCleanup",
        "runClear",
        "runAbandonRetainAndClear",
        "runTerminalRetainAndClear",
        "runCompensateAbsorption",
      ].includes(script)
    ) {
      argv.push(randomUUID());
    }
    const command = Reflect.get(this.redis, script) as (...args: string[]) => Promise<string[]>;
    return this.#dispatch(command, keys, argv);
  }

  async #dispatch(
    command: (...args: string[]) => Promise<string[]>,
    keys: string[],
    argv: string[]
  ): Promise<string[]> {
    await this.beforeCommand?.();
    return command.call(this.redis, ...keys, ...argv);
  }

  /**
   * Exposed for the guard's own test. Delegates through #call rather than calling
   * assertSingleSlot directly, so a mutation to the guard inside #call fails this test too
   * — not only the tests that happen to exercise a real script.
   *
   * With cross-tag (invalid) keys, assertSingleSlot throws synchronously inside #call,
   * before any promise exists, and that throw propagates straight out of this method. With
   * same-tag (valid) keys, #call would go on to dispatch a real script call; this method
   * never returns or awaits that promise, and swallows whatever it eventually settles to,
   * so a valid-key call here can never surface as an unhandled rejection in the caller.
   */
  assertKeysForTest(operation: string, keys: string[]): void {
    this.#call(operation as ScriptName, keys).catch(() => undefined);
  }

  async createIfAbsent(args: {
    record: WaitpointRecordInput;
    status: WaitpointStatus;
    completion?: WaitpointCompletion;
  }): Promise<CreateIfAbsentResult> {
    assertCompletionWithinLimits(args.completion, "createIfAbsent");
    const keys = waitpointKeys(args.record.id);

    const reply = await this.#call(
      "wpCreateIfAbsent",
      [keys.record],
      JSON.stringify(args.record),
      args.status,
      args.completion ? JSON.stringify(args.completion) : "",
      String(this.terminalRetentionMs),
      args.record.completedByTaskRunId ?? ""
    );

    if (reply[0] === "created") {
      return { outcome: "created" };
    }

    // reply[1] is '' only if the record hash exists with no 'r' field, which should never
    // happen — but ?? never fires on '', so a bare JSON.parse('') would throw an
    // undiagnosable SyntaxError instead of naming the waitpoint.
    const record = parseJson<WaitpointRecordInput>(reply[1]);
    if (!record) {
      throw new Error(`Waitpoint ${args.record.id} exists in the store with no record blob`);
    }

    return {
      outcome: "exists",
      record,
      status: reply[2] === "COMPLETED" ? "COMPLETED" : "PENDING",
      completion: parseJson<WaitpointCompletion>(reply[3]),
    };
  }

  async registerOrReport(args: {
    waitpointId: string;
    runId: string;
    blockId: string;
    batchIndex?: number | null;
    spanIdToComplete?: string;
    createdAt: string;
    /** The watching run's org, stored on the watcher so the fanout continuation routes without a lookup. */
    organizationId?: string;
  }): Promise<RegisterOrReportResult> {
    const keys = waitpointKeys(args.waitpointId);

    // batchIndex is nullable at the boundary (matching the column) and undefined inside,
    // because JSON.stringify drops an undefined field but keeps a null one.
    const watcher: WatcherEntry = {
      runId: args.runId,
      blockId: args.blockId,
      batchIndex: args.batchIndex ?? undefined,
      spanIdToComplete: args.spanIdToComplete,
      createdAt: args.createdAt,
      organizationId: args.organizationId,
    };

    const reply = await this.#call(
      "wpRegisterOrReport",
      [keys.record, keys.watchers, keys.queue],
      watcherField(args.runId, args.blockId, args.batchIndex),
      JSON.stringify(watcher)
    );

    if (reply[0] === "missing") {
      throw new WaitpointNotFoundError(args.waitpointId);
    }
    if (reply[0] === "completed") {
      // Registration after completion needs no fanout: the frozen envelope comes straight
      // back and the caller delivers it against the run's own shard.
      this.metrics.registrations?.add(1, { outcome: "reported_complete" });
      return {
        outcome: "completed",
        completion: parseJson<WaitpointCompletion>(reply[1]),
        completedByTaskRunId: reply[2] || undefined,
        record: parseJson<WaitpointRecordInput>(reply[3]),
      };
    }

    this.metrics.registrations?.add(1, { outcome: "registered" });
    return { outcome: "registered" };
  }

  /**
   * Freeze a waitpoint's completion and record the fanout obligation.
   *
   * Bounded regardless of watcher count: the atomic script needs only to know WHETHER any
   * watcher is queued. The watchers themselves are delivered later, in pages, by the fanout
   * worker.
   *
   * The hint is two-staged. Before the flip it is filed only if absent, so a crash between
   * the two operations still leaves discoverable work; after the flip it is scheduled for
   * now, but only when THIS call actually performed the flip and created fanout. That keeps
   * a duplicate or conflicting completion from moving an existing retry score earlier, and
   * still overrides the grace deferral a worker leaves if it swept the pre-flip window.
   *
   * A worker sweeping DURING that window must not retire the hint — the entry it exists for
   * is about to appear. `wpFanoutClaim` distinguishes that case.
   */
  async complete(args: {
    waitpointId: string;
    completion: WaitpointCompletion;
    /** Defaults to a fingerprint over the completion's semantic fields. */
    completionId?: string;
  }): Promise<CompleteResult> {
    // BEFORE the fingerprint: `completionFingerprint` copies, JSON-serializes and
    // synchronously hashes `output.inline`, so the size check has to precede it, not follow it.
    assertCompletionWithinLimits(args.completion, "complete");
    if (args.completionId !== undefined) {
      assertString(args.completionId, ENVELOPE_LIMITS.completionId, "completionId", "complete");
    }

    const keys = waitpointKeys(args.waitpointId);
    const completionId = args.completionId ?? completionFingerprint(args.completion);
    const now = this.clock();

    // Stage one, before the flip: file a hint only if none exists. An unconditional add
    // would move a pending fanout's retry score earlier, so a duplicate completion arriving
    // during a backoff would run failed deliveries at poll speed and burn the failure
    // budget well before the configured delays.
    await this.#fanoutIndex(args.waitpointId, "add-nx", { score: now });

    const reply = await this.#call(
      "wpComplete",
      [keys.record, keys.watchers, keys.queue, keys.fanout],
      JSON.stringify(args.completion),
      completionId,
      String(now),
      String(this.terminalRetentionMs)
    );

    if (reply[0] === "missing") {
      // The hint is LEFT IN PLACE: dropping it was a cross-slot check-then-delete that could
      // delete a concurrent create-and-complete's hint and strand real fanout. The worker
      // retires a genuinely orphaned hint itself on its next visit.
      throw new WaitpointNotFoundError(args.waitpointId);
    }

    if (reply[0] === "conflict") {
      this.metrics.conflicts?.add(1);
      // The hint is left in place: a conflicting completion does not change whether the
      // stored one still owes its watchers a delivery.
      throw new WaitpointCompletionConflictError({
        waitpointId: args.waitpointId,
        storedCompletionId: reply[2] ?? "",
        incomingCompletionId: completionId,
        storedCompletion: parseJson<WaitpointCompletion>(reply[1]),
      });
    }

    const fanout = decodeFanoutState(reply[2]);
    const outcome = reply[0] === "already" ? "already" : "completed";

    if (outcome === "completed" && fanout === "pending") {
      // Stage two: THIS call performed the flip and created the fanout, so the work is new
      // and owes nobody a backoff. Scheduling it now also overrides a grace deferral left
      // by a worker that swept the pre-flip window.
      await this.#fanoutIndex(args.waitpointId, "add", { score: now });
    } else if (fanout !== "pending") {
      // Nothing owed. Retiring the hint here is the fast path; if it fails the worker
      // retires it on its next visit instead.
      await this.#dropFanoutHint(args.waitpointId);
    }
    // An `already` outcome with fanout still pending leaves the score untouched: the entry
    // has a schedule of its own and this call has no standing to change it.

    this.metrics.completions?.add(1, { outcome, fanout });

    return { outcome, completion: parseJson<WaitpointCompletion>(reply[1]), fanout };
  }

  /**
   * Withdraw one watcher registration, so a completed waitpoint stops fanning out to a run
   * that has been cancelled or has gone terminal.
   *
   * Never throws on a missing record. This runs as cleanup, after the fact, and a terminal
   * record may already have expired.
   */
  async unregisterWatcher(args: {
    waitpointId: string;
    runId: string;
    /** Which block's registration to withdraw. Watchers are block-scoped. */
    blockId: string;
    batchIndex?: number | null;
  }): Promise<{ outcome: "unregistered" | "absent" | "missing" }> {
    const keys = waitpointKeys(args.waitpointId);

    const reply = await this.#call(
      "wpUnregisterWatcher",
      [keys.record, keys.watchers],
      watcherField(args.runId, args.blockId, args.batchIndex)
    );

    const outcome = reply[0] as "unregistered" | "absent" | "missing";
    if (outcome === "unregistered") {
      this.metrics.watchersUnregistered?.add(1);
    }
    return { outcome };
  }

  /**
   * Create a waitpoint under an idempotency key.
   *
   * The reservation and the record sit under different hash tags, so no script spans
   * them. That makes the ORDER load-bearing: create first, then reserve.
   *
   * Reserve-first would mean a crash between the two steps leaves a reservation naming a
   * waitpoint that does not exist. Every later request with that key loses the
   * reservation, blocks on the winner's id, and throws when it registers — correctly, but
   * forever, because an idempotency key commonly carries no expiry to clear it.
   *
   * Create-first inverts the failure: a crash leaves an orphan record that nothing ever
   * referenced, because its id is random and unpublished. No caller hangs, but nothing
   * currently reclaims that record either: the backstop collector the wider plan
   * describes is keyed off a run's status, and this orphan has no owning run, so that
   * collector never sees it. The record is harmless — inert, unreferenced, never
   * returned to anyone — but it is a real leak until a later ticket adds a reaper for
   * standalone idempotency-keyed orphans specifically.
   */
  async createWithIdempotencyKey(args: {
    record: WaitpointRecordInput;
    environmentId: string;
    idempotencyKey: string;
    // `created` means THIS CALL won the reservation, not that the id is new. A retry by the
    // original creator reports false, because the reservation it is losing to is its own. A
    // caller must not gate one-time side effects on it without handling that.
  }): Promise<{ waitpointId: string; created: boolean }> {
    // Standalone ids only. The discard below deletes this call's own record, and that is
    // only safe because a freshly minted id was never handed out, so nothing can reference
    // it. A RUN or BATCH id is DERIVED from its anchor, so any caller can recompute it and
    // register a watcher on it — discarding one could delete a record already in use.
    const parsed = parseWaitpointId(args.record.id);
    if (parsed.format !== "b32hexW" || (parsed.type !== "DATETIME" && parsed.type !== "MANUAL")) {
      throw new Error(
        `createWithIdempotencyKey requires a freshly minted DATETIME or MANUAL id, got ${args.record.id}`
      );
    }

    await this.createIfAbsent({ record: args.record, status: "PENDING" });

    const expiresAtMs = args.record.idempotencyKeyExpiresAt
      ? String(new Date(args.record.idempotencyKeyExpiresAt).getTime())
      : "";

    const reply = await this.#call(
      "wpIdemReserve",
      [idempotencyKey(args.environmentId, args.idempotencyKey)],
      args.record.id,
      expiresAtMs
    );

    if (reply[0] === "reserved") {
      return { waitpointId: args.record.id, created: true };
    }

    const winner = reply[1];
    if (winner !== args.record.id) {
      // Safe to discard: this id is random and was never handed to any caller, so no
      // watcher can reference it. All four keys share the record's tag.
      const keys = waitpointKeys(args.record.id);
      await this.#call("wpDiscard", [keys.record, keys.watchers, keys.queue, keys.fanout]);
    }

    return { waitpointId: winner, created: false };
  }

  async absorbBlockers(args: {
    runId: string;
    blockId: string;
    edges: BlockEdge[];
    /**
     * The block this operation believes it is replacing, or `undefined` for a run that should
     * have no block installed yet.
     *
     * The COMPARE-AND-SET. Block ids are random and carry no order, so "is this operation
     * newer than what is installed?" is not a question the store can answer by comparing them
     * — a delayed retry of block one looked exactly like a rollover onto block one and would
     * wipe block two's pending set and reinstate obsolete edges. Naming the expected
     * predecessor makes the two distinguishable, and a mismatch is refused as `stale`.
     */
    expectedPreviousBlockId?: string;
    /**
     * Stable across retries and unique to this additive operation. Each operation claims its edges;
     * compensation releases those claims and removes only edges with no remaining claims.
     * The adapter always supplies it. Direct calls without an ID retain their claims until block cleanup.
     */
    absorptionId?: string;
    registrationEvidence?: string;
    batchIndex?: number;
  }): Promise<AbsorbResult> {
    // Every reported completion, checked before the loop below serializes any of them. A
    // reported completion rides into absorption as a receipt, so it reaches the same
    // `JSON.stringify` an inline completion does and needs the same ceiling.
    for (const item of args.edges) {
      assertCompletionWithinLimits(item.reported?.completion, `absorbBlockers:${item.waitpointId}`);
      if (item.reported?.completion?.record !== undefined) {
        assertRetainedCompletion(item.reported.completion, item.waitpointId);
      }
    }

    const keys = runBlockKeys(args.runId);
    const replayCleanup = args.expectedPreviousBlockId
      ? await this.#withdrawSupersededWatchers(args.runId, args.expectedPreviousBlockId)
      : undefined;

    // No fast path for an empty list: storePendingTotal is defined as the run's WHOLE
    // store-resident pending set, so it has to be read even when nothing is requested.
    const expectsPrevious = args.expectedPreviousBlockId !== undefined;
    const argv: string[] = [
      args.blockId,
      expectsPrevious ? "1" : "0",
      args.expectedPreviousBlockId ?? "",
      String(args.edges.length),
    ];
    for (const item of args.edges) {
      const { reported, ...stored } = item;
      const reportedFlag = reported !== undefined ? "1" : "0";
      const reportedJson = reported?.completion ? JSON.stringify(reported.completion) : "";
      argv.push(
        item.waitpointId,
        edgeField(item.waitpointId, item.batchIndex),
        JSON.stringify(stored),
        reportedFlag,
        reportedJson
      );
    }

    const reply = await this.#call(
      "runAbsorbBlockers",
      [
        keys.pend,
        keys.done,
        keys.edge,
        keys.state,
        runContributionKey(args.runId, args.blockId, args.absorptionId ?? ""),
        runResultKey(args.runId),
        keys.refs,
        keys.edgeIndex,
        keys.doneOrder,
        keys.early,
        keys.earlyOrder,
        runWithdrawalKey(args.runId, args.expectedPreviousBlockId ?? ""),
        runWithdrawalTargetsKey(args.runId, args.expectedPreviousBlockId ?? ""),
        runContributionIndexKey(args.runId),
      ],
      ...argv,
      args.absorptionId ?? "",
      contributionMember(args.blockId, args.absorptionId ?? ""),
      args.registrationEvidence ??
        registrationEvidence(
          args.edges.map((edge) => edge.waitpointId),
          args.batchIndex ?? args.edges[0]?.batchIndex ?? undefined
        )
    );

    // Refused scripts mutate no active block state. An earlier retained predecessor can still
    // converge on a stale retry; the caller must not register, so this is a result and not a partial
    // absorb: `registerBlocks` stops here, and a direct caller reads `outcome`.
    if (reply[0] === "stale" || reply[0] === "terminal" || reply[0] === "cleanupOwed") {
      this.metrics.staleAbsorbs?.add(1, { outcome: reply[0] });
      return {
        // `cleanupOwed`: a previous mixed block's cross-store cleanup is still owed, so this DIFFERENT block
        // is refused (active block unchanged) until the fence clears — reply[1] is the block that owes cleanup.
        outcome: reply[0],
        currentBlockId: reply[1] || undefined,
        pendingOfRequested: 0,
        storePendingTotal: 0,
        alreadyDelivered: [],
      };
    }

    // Slots 3 and 4 are the superseded block and its field count; the delivered pairs start
    // after the fields those two delimit. See the `out` table in runAbsorbBlockers.
    const supersededBlockId = reply[3] ?? "";
    const supersededFieldCount = Number(reply[4] ?? 0);

    const alreadyDelivered: AbsorbResult["alreadyDelivered"] = [];
    for (let i = 5 + supersededFieldCount; i < reply.length; i += 2) {
      alreadyDelivered.push({
        waitpointId: reply[i]!,
        completion: parseJson<WaitpointCompletion & { record?: WaitpointRecordInput }>(
          reply[i + 1]
        ),
      });
    }

    // Fresh targets exist only after the atomic rollover committed. A retry may also have
    // converged an already-retained predecessor before the CAS, without touching active state.
    const supersededCleanup = supersededBlockId
      ? await this.#withdrawSupersededWatchers(args.runId, supersededBlockId)
      : replayCleanup;

    return {
      outcome: "absorbed",
      pendingOfRequested: Number(reply[1]),
      storePendingTotal: Number(reply[2]),
      alreadyDelivered,
      supersededCleanup,
    };
  }

  /**
   * Withdraw a detached predecessor in bounded, replay-safe pages. Watcher fields contain the block
   * identity, so this never removes a newer block's registration. Retire only successful targets;
   * failures remain in the no-TTL manifest for an explicit predecessor retry/reconciliation. Current
   * application block-operation builders do not request rollover; this is the primitive's contract,
   * not an automatically scheduled recovery promise.
   */
  async #withdrawSupersededWatchers(
    runId: string,
    blockId: string
  ): Promise<SupersededCleanup | undefined> {
    let page = await this.readWithdrawalPage({ runId, blockId });
    if (!page) return undefined;
    const failed: SupersededCleanup["failed"] = [];
    let withdrawn = 0;
    while (page.fields.length > 0) {
      const acknowledged: string[] = [];
      await pMap(
        page.fields,
        async (field) => {
          const target = parseEdgeField(field);
          if (!target) throw new Error(`Invalid retained withdrawal target: ${field}`);
          try {
            await this.unregisterWatcher({ ...target, runId, blockId });
            acknowledged.push(field);
            withdrawn++;
          } catch (error) {
            failed.push({
              ...target,
              error: error instanceof Error ? error.message : String(error),
            });
            this.metrics.supersededWatcherCleanupFailures?.add(1);
          }
        },
        { concurrency: SUPERSEDED_CLEANUP_CONCURRENCY }
      );
      // Successful targets can be retired even if their page has failures. Failed targets remain
      // durably discoverable by the same predecessor identity on a stale or ordinary caller retry.
      await this.acknowledgeWithdrawalPage({ runId, blockId, fields: acknowledged });
      if (failed.length > 0) break;
      const next = await this.readWithdrawalPage({ runId, blockId });
      if (!next) return { blockId, withdrawn, failed }; // Another retrier finalized the same manifest.
      page = next;
    }
    if (failed.length === 0) await this.finalizeRetainedWithdrawal({ runId, blockId });
    return { blockId, withdrawn, failed };
  }

  /**
   * Steps 4 and 5 of the block sequence: register the run against each waitpoint, and
   * immediately deliver any completion the registration reports.
   *
   * Split out because step 3 sits between them. The design has the caller publish its
   * blocked TRES transition AFTER absorbing and BEFORE registering, so a caller that owes
   * that transition calls `absorbBlockers`, publishes, then calls this — and must not
   * absorb a second time, which would reinstall the block and re-run the rollover.
   *
   * The two supported flows are therefore `absorbBlockers` → publish → `registerAndDeliver`,
   * or `registerBlocks` when nothing belongs between the halves. There is no third.
   *
   * A completion landing in that gap is not lost: the register reports the frozen envelope
   * instead of taking a watcher, and it is delivered here against the block already
   * installed.
   *
   * A throw partway through intentionally leaves the earlier watchers registered and the
   * run absorbed on every id. Nothing resumes early, and repairing that residue is
   * deliberately not this operation's job.
   */
  async registerAndDeliver(args: {
    runId: string;
    blockId: string;
    edges: BlockEdge[];
    /** The watching run's org, stored on each watcher so the fanout continuation routes without a lookup. */
    organizationId?: string;
    /**
     * What `absorbBlockers` reported for this same block. REQUIRED: registration is step 4
     * of the block sequence and step 2 always precedes it, so there is no supported flow in
     * which a run is registered without having been absorbed first. Passing it also lets
     * the result describe the whole block rather than only this half.
     */
    absorbed: Pick<AbsorbResult, "storePendingTotal" | "alreadyDelivered" | "supersededCleanup">;
  }): Promise<AbsorbResult> {
    // Distinct, because two edges on one waitpoint are one blocker.
    const delivered = new Map<string, WaitpointCompletion | undefined>(
      args.absorbed.alreadyDelivered.map((entry) => [entry.waitpointId, entry.completion])
    );
    let storePendingTotal = args.absorbed.storePendingTotal;

    // Absorption returns receipts under the current block's atomic fence. Their immutable metadata
    // survives source expiry, so replay must consume it rather than registering an already-delivered
    // waitpoint again. Older receipts without metadata still require the ordinary source validation.
    const cbtByWaitpoint = new Map<string, string | undefined>();
    const retained = new Map(
      args.absorbed.alreadyDelivered.map((entry) => [entry.waitpointId, entry])
    );

    for (const item of args.edges) {
      const retainedCompletion = retained.get(item.waitpointId)?.completion;
      if (retainedCompletion?.record !== undefined) {
        assertRetainedCompletion(retainedCompletion, item.waitpointId);
        cbtByWaitpoint.set(item.waitpointId, retainedCompletion.record.completedByTaskRunId);
        continue;
      }
      const result = await this.registerOrReport({
        waitpointId: item.waitpointId,
        runId: args.runId,
        blockId: args.blockId,
        batchIndex: item.batchIndex,
        spanIdToComplete: item.spanIdToComplete,
        createdAt: item.createdAt,
        organizationId: args.organizationId,
      });

      if (result.outcome === "completed" && !cbtByWaitpoint.has(item.waitpointId)) {
        cbtByWaitpoint.set(item.waitpointId, result.completedByTaskRunId);
      }

      if (result.outcome !== "completed" || delivered.has(item.waitpointId)) {
        continue;
      }

      // Keyed on OUTCOME, never on whether an envelope came back: a waitpoint can be
      // reported COMPLETED with none, and that case must still stop blocking the run.
      const receipt = await this.deliverCompletion({
        runId: args.runId,
        blockId: args.blockId,
        waitpointId: item.waitpointId,
        completion: result.completion,
        requireCurrentBlock: true,
        record: result.record,
      });
      delivered.set(item.waitpointId, result.completion);
      storePendingTotal = receipt.storePendingTotal;
    }

    const requested = new Set(args.edges.map((edge) => edge.waitpointId));
    let pendingOfRequested = 0;
    for (const waitpointId of requested) {
      if (!delivered.has(waitpointId)) {
        pendingOfRequested++;
      }
    }

    // Cached-span completions for edges whose delivery happened here (early or racing) and that carry a
    // span. Independent of resumability — one blocker may close its span while others stay pending. The
    // completed run identity (cachedRunId) came back ATOMICALLY with each completion above, so it can never
    // diverge from the envelope at the record's expiry.
    const cachedSpanCompletions = args.edges
      .filter((edge) => edge.spanIdToComplete && delivered.has(edge.waitpointId))
      .map((edge) => ({
        spanId: edge.spanIdToComplete!,
        spanCreatedAt: edge.createdAt,
        blockedRunId: args.runId,
        hasError: delivered.get(edge.waitpointId)?.outputIsError ?? false,
        cachedRunId: cbtByWaitpoint.get(edge.waitpointId),
      }));

    return {
      cachedSpanCompletions,
      // This half only runs once absorption succeeded — a refusal never reaches it.
      outcome: "absorbed",
      pendingOfRequested,
      storePendingTotal,
      supersededCleanup: args.absorbed.supersededCleanup,
      alreadyDelivered: [...delivered].map(([waitpointId, completion]) => ({
        waitpointId,
        completion,
      })),
    };
  }

  /**
   * Block a run on a set of waitpoints: absorb, then register, then deliver.
   *
   * A convenience composition of `absorbBlockers` and `registerAndDeliver` for a caller
   * with NOTHING to publish between the two. A caller that owes a blocked TRES transition
   * must call the two halves itself, with the transition in between — see
   * `registerAndDeliver`.
   *
   * Absorb first, then register. That ordering is the protocol: it prefers a recoverable
   * orphaned coordination record over a committed blocked run with no recoverable
   * registration. A crash after absorbing leaves ids pending with no watcher, which the
   * authoritative run state can repair; a crash after registering but before absorbing
   * would leave a watcher whose delivery lands on a run that never blocked.
   */
  async registerBlocks(args: {
    runId: string;
    /** A FRESH id per block operation — see `runAbsorbBlockers` for why reuse is unsafe. */
    blockId: string;
    /** The contribution identity; defaults to the block id when the caller runs one absorption per block. */
    absorptionId?: string;
    edges: BlockEdge[];
    /** Forwarded to `absorbBlockers` as the compare-and-set precondition. */
    expectedPreviousBlockId?: string;
  }): Promise<AbsorbResult> {
    const absorbed = await this.absorbBlockers({
      runId: args.runId,
      blockId: args.blockId,
      edges: args.edges.map(({ reported: _reported, ...edge }) => edge),
      expectedPreviousBlockId: args.expectedPreviousBlockId,
      absorptionId: args.absorptionId ?? args.blockId,
    });

    // A refusal stops here. Registering for a block the store declined to install would leave
    // watchers on waitpoint shards that no run-side block will ever accept a delivery for.
    if (absorbed.outcome !== "absorbed") {
      return absorbed;
    }

    return this.registerAndDeliver({ ...args, absorbed });
  }

  /**
   * Deliver a frozen completion onto one run's shard, idempotently and at most once in
   * effect.
   *
   * `blockId` is the block operation the watcher registered under, NOT the run's current
   * one. Delivery is refused when the run has moved on, so a completion still in flight
   * from a finished block cannot clear a pending id or wake a newer one.
   */
  async deliverCompletion(args: {
    runId: string;
    blockId: string;
    waitpointId: string;
    /**
     * Absent for a waitpoint that is COMPLETED with no envelope — the FINISHED-healing
     * shape. It still has to be delivered, or the run blocks forever on something already
     * done; the receipt is simply empty.
     */
    completion?: WaitpointCompletion;
    record?: WaitpointRecordInput;
    /** Production delivery follows absorption; refuse absence after cleanup/expiry. */
    requireCurrentBlock?: boolean;
  }): Promise<DeliverResult> {
    return this.deliverEncodedCompletion({
      ...args,
      encoded: encodeCompletionForDelivery(args.completion, "deliverCompletion", args.record),
    });
  }

  /**
   * `deliverCompletion` against a completion already checked and serialized once.
   *
   * The fanout worker delivers one completion to every watcher on a claimed page, so it encodes
   * once per claim and calls this per watcher. Same script, same ARGV, same stored bytes — the
   * only difference is that the serialization is not repeated per delivery.
   */
  async deliverEncodedCompletion(args: {
    runId: string;
    blockId: string;
    waitpointId: string;
    encoded: EncodedWaitpointCompletion;
    requireCurrentBlock?: boolean;
  }): Promise<DeliverResult> {
    if (!EncodedWaitpointCompletion.isEncoded(args.encoded)) {
      throw new TypeError(
        "deliverEncodedCompletion requires an EncodedWaitpointCompletion from encodeCompletionForDelivery"
      );
    }

    const keys = runBlockKeys(args.runId);

    const reply = await this.#call(
      "runDeliverCompletion",
      [
        keys.pend,
        keys.done,
        keys.state,
        runResultKey(args.runId),
        keys.refs,
        keys.doneOrder,
        keys.early,
        keys.earlyOrder,
      ],
      args.blockId,
      args.waitpointId,
      args.encoded.json,
      args.requireCurrentBlock ? "1" : "0"
    );

    const outcome = reply[0] as DeliverResult["outcome"];
    this.metrics.deliveries?.add(1, { outcome });

    return {
      outcome,
      storePendingTotal: Number(reply[1]),
      resumable: reply[2] === "1",
      currentBlockId: reply[3] || undefined,
    };
  }

  /**
   * Record that TRES has durably accepted the resume transition for this block, then drain
   * the block's edges and the receipts nothing references any more.
   *
   * This is the run-side durability boundary. Until it is called, `cleanupRunBlockState`
   * refuses to arm the terminal window and the receipts stay readable, so a transient TRES
   * failure costs a retry rather than the completions.
   *
   * The ack is marked before the drain, never after — see `runMarkHandoffAcked`.
   */
  async acknowledgeResumeHandoff(args: {
    runId: string;
    blockId: string;
    /** Edges to drain. Omit to acknowledge without draining. */
    edgeIds?: string[];
  }): Promise<{ outcome: "acknowledged" | "stale" | "unknown"; currentBlockId?: string }> {
    const keys = runBlockKeys(args.runId);

    const reply = await this.#call("runMarkHandoffAcked", [keys.state], args.blockId);
    const outcome = reply[0] as "acknowledged" | "stale" | "unknown";

    if (outcome !== "acknowledged") {
      return { outcome, currentBlockId: reply[1] || undefined };
    }

    // The drain carries the ACKNOWLEDGED block id, so a rollover between the two calls makes
    // it a no-op instead of a destructive clear of the newer cycle. A stale drain after a
    // successful acknowledgement is safe: the rollover already swept the old cycle's state.
    if (args.edgeIds && args.edgeIds.length > 0) {
      await this.clearBlockState({
        runId: args.runId,
        blockId: args.blockId,
        edgeIds: args.edgeIds,
      });
    }

    return { outcome };
  }

  /**
   * Arm the terminal retention window on a run's coordination state.
   *
   * With `reason: "resume"` and an outstanding handoff obligation this refuses and changes
   * nothing. `"cancelled"` and `"terminal"` discharge the obligation, because neither run
   * will ever publish a resume transition.
   *
   * A run with no coordination state at all reports `armed` with `state: "absent"` and
   * writes nothing, so this is safe to call for every terminal run.
   */
  async cleanupRunBlockState(args: {
    runId: string;
    reason: CleanupReason;
  }): Promise<CleanupResult> {
    const keys = runBlockKeys(args.runId);
    const voidHandoff = args.reason === "resume" ? "0" : "1";

    const reply = await this.#call(
      "runTerminalCleanup",
      [
        keys.pend,
        keys.done,
        keys.edge,
        keys.state,
        runResultKey(args.runId),
        keys.refs,
        keys.edgeIndex,
        keys.doneOrder,
        keys.early,
        keys.earlyOrder,
      ],
      String(this.clock()),
      String(this.terminalRetentionMs),
      voidHandoff
    );

    if (reply[0] === "retained") {
      this.metrics.cleanups?.add(1, { reason: args.reason, outcome: "retained" });
      return { outcome: "retained", reason: "handoff-owed" };
    }

    const state = reply[2] === "absent" ? "absent" : "present";
    this.metrics.cleanups?.add(1, { reason: args.reason, outcome: "armed", state });
    return { outcome: "armed", handoffWas: decodeHandoff(reply[1]), state };
  }

  /**
   * Withdraw this run's registrations on cancellation or terminal completion of a blocked run, TERMINAL
   * FIRST: {@link terminalRetainAndClear} atomically installs the fence, clears the active block, arms the
   * tombstone TTL and captures the withdrawal targets into the durable (no-TTL) record BEFORE any watcher
   * is withdrawn cross-shard. So a fanout page claimed before the withdrawal refuses as `terminal`, and a
   * partial withdrawal (or crash) leaves every unacknowledged target in the retained hash for
   * {@link resumeRetainedWithdrawal} to finish — even after the ordinary run-state keys have expired. The
   * record is removed only once every target has converged (a thrown Redis error rejects here and keeps
   * it). The loop width is the run's own blocker count, never the waitpoint's watcher count.
   */
  async releaseRunWatchers(args: {
    runId: string;
    reason: Exclude<CleanupReason, "resume">;
    /**
     * Which block's registrations to withdraw. Defaults to the run's current block, which
     * is the one a cancellation or terminal completion is interrupting.
     */
    blockId?: string;
    /** Concurrent unregistrations. Bounded so a wide batch cannot flood the cluster. */
    concurrency?: number;
  }): Promise<{ unregistered: number; cleanup: CleanupResult }> {
    const target = args.blockId ?? (await this.currentBlockId(args.runId));
    if (!target) {
      // Resumed snapshots may still own results after their active block was acknowledged.
      // This terminal-only operation fences delivery and arms result retention in one slot.
      const cleanup = await this.cleanupRunBlockState({ runId: args.runId, reason: args.reason });
      await this.retireRunRegistrationSources(args.runId);
      return { unregistered: 0, cleanup };
    }

    const retained = await this.terminalRetainAndClear({ runId: args.runId, blockId: target });
    if (retained.outcome === "stale") {
      return {
        unregistered: 0,
        cleanup: { outcome: "armed", handoffWas: "none", state: "present" },
      };
    }

    await this.retireRunRegistrationSources(args.runId);
    let unregistered = 0;
    for (;;) {
      const page = await this.readWithdrawalPage({ runId: args.runId, blockId: target });
      if (!page || page.fields.length === 0) break;
      const outcomes = await pMap(
        page.fields,
        (field) => {
          const parsed = parseEdgeField(field);
          if (!parsed) throw new Error(`Invalid retained withdrawal target: ${field}`);
          return this.unregisterWatcher({
            waitpointId: parsed.waitpointId,
            runId: args.runId,
            blockId: target,
            batchIndex: parsed.batchIndex,
          });
        },
        { concurrency: Math.max(1, Math.min(args.concurrency ?? 10, RUN_CLEANUP_PAGE_SIZE)) }
      );
      unregistered += outcomes.filter((o) => o.outcome === "unregistered").length;
      // A crash before this acknowledgement replays the whole page idempotently. Never acknowledge
      // a partially failed page; retained targets outlive source records and the terminal tombstone.
      await this.acknowledgeWithdrawalPage({
        runId: args.runId,
        blockId: target,
        fields: page.fields,
      });
    }
    await this.finalizeRetainedWithdrawal({ runId: args.runId, blockId: target });

    return {
      unregistered,
      cleanup: { outcome: "armed", handoffWas: "none", state: "present" },
    };
  }

  /**
   * ATOMICALLY record ONE block's watcher-withdrawal targets and clear its active run-side state, so a
   * crash before withdrawal can never strand an active block with no watchers. Fenced to the exact block:
   * a stale/terminal block writes and clears nothing. Read and acknowledge bounded pages to drain it.
   */
  async abandonRetainAndClear(args: {
    runId: string;
    blockId: string;
  }): Promise<
    { outcome: "retained" } | { outcome: "stale" | "terminal"; currentBlockId?: string }
  > {
    const keys = runBlockKeys(args.runId);
    const reply = await this.#call(
      "runAbandonRetainAndClear",
      [
        keys.pend,
        keys.done,
        keys.edge,
        keys.state,
        runWithdrawalKey(args.runId, args.blockId),
        runWithdrawalTargetsKey(args.runId, args.blockId),
        keys.refs,
        keys.edgeIndex,
        keys.doneOrder,
        keys.early,
        keys.earlyOrder,
      ],
      args.blockId
    );
    if (reply[0] === "retained") {
      return { outcome: "retained" };
    }
    return { outcome: reply[0] as "stale" | "terminal", currentBlockId: reply[1] || undefined };
  }

  /**
   * ATOMICALLY retain ONE block's watcher-withdrawal targets and terminalize the run: it installs the
   * terminal fence, clears the active block and arms the retention TTL on the run-state tombstone ONLY,
   * capturing the withdrawal targets in the SAME durable (no-TTL) record the non-terminal abandon uses. So
   * a watcher withdrawal still owed after the fortnight tombstone expires never loses its target list.
   * Fenced to the exact block; a run with no coordination state writes nothing.
   */
  async terminalRetainAndClear(args: {
    runId: string;
    blockId: string;
  }): Promise<
    { outcome: "retained" } | { outcome: "absent" | "stale" | "terminal"; currentBlockId?: string }
  > {
    const keys = runBlockKeys(args.runId);
    const reply = await this.#call(
      "runTerminalRetainAndClear",
      [
        keys.pend,
        keys.done,
        keys.edge,
        keys.state,
        runWithdrawalKey(args.runId, args.blockId),
        runResultKey(args.runId),
        runWithdrawalTargetsKey(args.runId, args.blockId),
        keys.refs,
        keys.edgeIndex,
        keys.doneOrder,
        keys.early,
        keys.earlyOrder,
      ],
      args.blockId,
      String(this.clock()),
      String(this.terminalRetentionMs)
    );
    if (reply[0] === "retained") {
      return { outcome: "retained" };
    }
    return {
      outcome: reply[0] as "absent" | "stale" | "terminal",
      currentBlockId: reply[1] || undefined,
    };
  }

  /**
   * Durably mark this run's exact current store block as cleanup-owed. While set, {@link absorbBlockers}
   * refuses a DIFFERENT block. Armed before the retry/requeue transition; cleared only once the block's
   * cross-store cleanup has fully converged.
   */
  async armCleanupFence(args: { runId: string; blockId: string }): Promise<void> {
    await this.#call("runArmCleanupFence", [runBlockKeys(args.runId).state], args.blockId);
  }

  /** Read only the existing cleanup fence; never install an empty block for a legacy wait. */
  async readCleanupFence(runId: string): Promise<string | undefined> {
    const reply = await this.#call("runReadCleanupFence", [runBlockKeys(runId).state]);
    return reply[0] || undefined;
  }

  /** Lift the cleanup-owed fence, but only when it names this exact block. */
  async clearCleanupFence(args: { runId: string; blockId: string }): Promise<void> {
    await this.#call("runClearCleanupFence", [runBlockKeys(args.runId).state], args.blockId);
  }

  /** Read at most one hard-bounded, non-consuming page of this block's durable withdrawal targets. */
  async readWithdrawalPage(args: {
    runId: string;
    blockId: string;
  }): Promise<{ blockId: string; fields: string[] } | undefined> {
    const reply = await this.#call(
      "runWithdrawalPage",
      [
        runWithdrawalKey(args.runId, args.blockId),
        runWithdrawalTargetsKey(args.runId, args.blockId),
      ],
      args.blockId,
      "read"
    );
    return reply[0] === "absent" ? undefined : { blockId: args.blockId, fields: reply.slice(1) };
  }

  /** Acknowledge only targets whose watchers have converged. Duplicate/stale acknowledgements are safe. */
  async acknowledgeWithdrawalPage(args: {
    runId: string;
    blockId: string;
    fields: string[];
  }): Promise<void> {
    if (args.fields.length > RUN_CLEANUP_PAGE_SIZE)
      throw new Error("Withdrawal page exceeds limit");
    await this.#call(
      "runWithdrawalPage",
      [
        runWithdrawalKey(args.runId, args.blockId),
        runWithdrawalTargetsKey(args.runId, args.blockId),
      ],
      args.blockId,
      "ack",
      ...args.fields
    );
  }

  /**
   * ATOMICALLY retire a converged block's recovery evidence: delete its retained-withdrawal record and,
   * in the same same-slot step, clear its cleanup-owed fence when it names this exact block. Called only
   * after every retained target is absent/unregistered, so the record and its matching fence can never be
   * separated by a process crash. Returns whether the fence was cleared.
   */
  async finalizeRetainedWithdrawal(args: {
    runId: string;
    blockId: string;
  }): Promise<{ fenceCleared: boolean }> {
    const keys = runBlockKeys(args.runId);
    const reply = await this.#call(
      "runFinalizeRetainedWithdrawal",
      [
        runWithdrawalKey(args.runId, args.blockId),
        keys.state,
        runWithdrawalTargetsKey(args.runId, args.blockId),
      ],
      args.blockId
    );
    if (reply[0] === "retained") throw new Error("Withdrawal still has unacknowledged targets");
    return { fenceCleared: reply[0] === "cleared" };
  }

  /** Terminal callers hold the parent lock and fence registration before retiring its sources. */
  async retireRunRegistrationSources(runId: string): Promise<void> {
    await this.beforeCommand?.();
    for (;;) {
      const members = await this.redis.zrange(
        runContributionIndexKey(runId),
        0,
        RUN_CLEANUP_PAGE_SIZE - 1
      );
      if (members.length === 0) return;
      for (const member of members) {
        const identity: unknown = JSON.parse(member);
        if (
          !Array.isArray(identity) ||
          identity.length !== 2 ||
          !identity.every((part) => typeof part === "string")
        ) {
          throw new Error("Invalid registration contribution identity");
        }
        await this.deleteContribution({ runId, blockId: identity[0], absorptionId: identity[1] });
      }
    }
  }

  /** Record release targets before acquiring source holds. The caller holds the parent lock. */
  async prepareRegistrationSources(args: {
    runId: string;
    blockId: string;
    absorptionId: string;
    waitpointIds: string[];
    evidence: string;
    expectedPreviousBlockId?: string;
  }): Promise<void> {
    await this.beforeCommand?.();
    const keys = [
      runBlockKeys(args.runId).state,
      runContributionKey(args.runId, args.blockId, args.absorptionId),
      runRegistrationSourcesKey(args.runId, args.blockId, args.absorptionId),
      runContributionIndexKey(args.runId),
    ];
    assertSingleSlot("prepareRegistrationSources", keys);
    const prepared = await this.redis.eval(
      `
      local current = redis.call('HGET', KEYS[1], 'blk') or ''
      local fence = redis.call('HGET', KEYS[1], 'co') or ''
      if redis.call('HGET', KEYS[1], 'term') == '1' or
        (fence ~= '' and fence ~= ARGV[1]) or
        (current ~= ARGV[1] and current ~= ARGV[2]) then return 0 end
      if redis.call('SCARD', KEYS[2]) > 0 and
        redis.call('SISMEMBER', KEYS[2], ARGV[3]) == 0 then
        return redis.error_reply('Registration request does not match its preparation')
      end
      if redis.call('SISMEMBER', KEYS[2], '!registered') == 1 then return 0 end
      redis.call('SADD', KEYS[2], ARGV[3])
      redis.call('ZADD', KEYS[4], 0, ARGV[4])
      for i = 5, #ARGV do redis.call('ZADD', KEYS[3], 0, ARGV[i]) end
      return 1
      `,
      keys.length,
      ...keys,
      args.blockId,
      args.expectedPreviousBlockId ?? "",
      args.evidence,
      contributionMember(args.blockId, args.absorptionId),
      ...args.waitpointIds
    );
    if (prepared !== 1) return; // Absorption still performs the authoritative block CAS.
    const token = this.#registrationHoldToken(args);
    for (const waitpointId of args.waitpointIds) {
      // A missing source may have a retained parent result; the subsequent read decides.
      await this.redis.eval(
        `if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
         if redis.call('HSETNX', KEYS[1], ARGV[1], '1') == 1 then
           redis.call('HINCRBY', KEYS[1], 'rh', 1)
         end
         redis.call('PERSIST', KEYS[1])
         return 1`,
        1,
        waitpointKeys(waitpointId).record,
        token
      );
    }
  }

  #registrationHoldToken(args: { runId: string; blockId: string; absorptionId: string }): string {
    return (
      "rh:" +
      createHash("sha256")
        .update(JSON.stringify([args.runId, args.blockId, args.absorptionId]))
        .digest("hex")
    );
  }

  /** Keep each target discoverable until its exact hold is released. Replays are harmless. */
  async releaseRegistrationSources(args: {
    runId: string;
    blockId: string;
    absorptionId: string;
  }): Promise<void> {
    await this.beforeCommand?.();
    const manifest = runRegistrationSourcesKey(args.runId, args.blockId, args.absorptionId);
    const token = this.#registrationHoldToken(args);
    for (;;) {
      const sources = await this.redis.zrange(manifest, 0, RUN_CLEANUP_PAGE_SIZE - 1);
      if (sources.length === 0) return;
      for (const waitpointId of sources) {
        const keys = waitpointKeys(waitpointId);
        await this.redis.eval(
          `local record, ttl = KEYS[1], tonumber(ARGV[2])
           if redis.call('EXISTS', record) == 0 then return 0 end
           if redis.call('HDEL', KEYS[1], ARGV[1]) == 1 then
             local remaining = redis.call('HINCRBY', KEYS[1], 'rh', -1)
             if remaining == 0 then redis.call('HDEL', KEYS[1], 'rh') end
           end
           local fanout = redis.call('HGET', KEYS[2], 'state') or ''
           if (tonumber(redis.call('HGET', KEYS[1], 'rh')) or 0) == 0 and
             redis.call('HGET', KEYS[1], 'status') == 'COMPLETED' and
             (fanout == '' or fanout == 'done') and redis.call('PTTL', KEYS[1]) < 0 then
${RETAIN_WAITPOINT_RECORD}
           end
           return 1`,
          2,
          keys.record,
          keys.fanout,
          token,
          String(this.terminalRetentionMs)
        );
        await this.redis.zrem(manifest, waitpointId);
      }
    }
  }

  /**
   * Check the request hash with a fixed number of Redis reads. Do not read or change edge lists.
   * Hold the parent run lock across this check and the recovery attempt.
   */
  async hasAbsorbedBlockers(args: {
    runId: string;
    blockId: string;
    absorptionId: string;
    waitpointIds: string[];
    batchIndex?: number;
  }): Promise<boolean> {
    await this.beforeCommand?.();
    const keys = runBlockKeys(args.runId);
    const [blockId, terminal] = await this.redis.hmget(keys.state, "blk", "term");
    if (blockId !== args.blockId || terminal === "1") return false;
    if (
      !(await this.redis.sismember(
        runContributionKey(args.runId, args.blockId, args.absorptionId),
        "!accepted"
      ))
    )
      return false;
    return (
      (await this.redis.sismember(
        runContributionKey(args.runId, args.blockId, args.absorptionId),
        registrationEvidence(args.waitpointIds, args.batchIndex)
      )) === 1
    );
  }

  /** Remove cleanup targets after phase 3. Keep the request proof until registration finishes. */
  async markRegistrationComplete(args: {
    runId: string;
    blockId: string;
    absorptionId: string;
    evidence: string;
  }): Promise<void> {
    await this.beforeCommand?.();
    const key = runContributionKey(args.runId, args.blockId, args.absorptionId);
    await this.redis.eval(
      `
      if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 0 then
        return redis.error_reply('Missing registration acceptance proof')
      end
      redis.call('UNLINK', KEYS[1])
      redis.call('SADD', KEYS[1], ARGV[1], '!accepted', '!registered')
      return 1
    `,
      1,
      key,
      args.evidence
    );
    await this.releaseRegistrationSources(args);
  }

  /** The edge fields claimed by one absorption, or [] once registered/compensated. */
  async readContribution(args: {
    runId: string;
    blockId: string;
    absorptionId: string;
  }): Promise<string[]> {
    await this.beforeCommand?.();
    return (
      await this.redis.smembers(runContributionKey(args.runId, args.blockId, args.absorptionId))
    ).filter((field) => !field.startsWith("!"));
  }

  /** Remove the request proof and its index entry after registration finishes. */
  async deleteContribution(args: {
    runId: string;
    blockId: string;
    absorptionId: string;
  }): Promise<void> {
    await this.releaseRegistrationSources(args);
    await this.#call(
      "runDeleteContribution",
      [
        runContributionKey(args.runId, args.blockId, args.absorptionId),
        runContributionIndexKey(args.runId),
      ],
      contributionMember(args.blockId, args.absorptionId)
    );
  }

  /**
   * Roll back one absorption in bounded atomic pages, each fenced to the exact current block. Remove
   * only edges with no remaining claims and their now-unreferenced receipts/pending ids; unrelated early receipts
   * may still belong to concurrent additive registrations. The last page clears a phantom block unless
   * its cleanup fence still owns it. Each page consumes its contribution in the same commit as removal,
   * so replay never loses an unfinished target or touches a newer/terminal block. `removed` counts fields
   * consumed during this invocation, not earlier pages whose reply was lost.
   */
  async compensateAbsorption(args: {
    runId: string;
    blockId: string;
    absorptionId: string;
    unacceptedEvidence?: string;
  }): Promise<{ outcome: "cleared" | "retained" | "stale"; surviving: number; removed: number }> {
    if (args.unacceptedEvidence !== undefined) {
      await this.beforeCommand?.();
      const matches = await this.redis.eval(
        `return redis.call('SISMEMBER', KEYS[1], '!accepted') == 0 and
          redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 and 1 or 0`,
        1,
        runContributionKey(args.runId, args.blockId, args.absorptionId),
        args.unacceptedEvidence
      );
      if (matches !== 1) return { outcome: "retained", surviving: 0, removed: 0 };
    }
    await this.releaseRegistrationSources(args);
    const keys = runBlockKeys(args.runId);
    let removed = 0;
    for (;;) {
      const reply = await this.#call(
        "runCompensateAbsorption",
        [
          keys.pend,
          keys.done,
          keys.edge,
          keys.state,
          runContributionKey(args.runId, args.blockId, args.absorptionId),
          keys.refs,
          keys.edgeIndex,
          keys.doneOrder,
          keys.early,
          keys.earlyOrder,
          runContributionIndexKey(args.runId),
        ],
        args.blockId,
        args.absorptionId,
        contributionMember(args.blockId, args.absorptionId)
      );
      removed += Number(reply[2]);
      if (Number(reply[3]) === 0) {
        return {
          outcome: reply[0] as "cleared" | "retained" | "stale",
          surviving: Number(reply[1]),
          removed,
        };
      }
    }
  }

  /** Fixed-size identity lookup for lifecycle cleanup; never materializes blocker collections. */
  async currentBlockId(runId: string): Promise<string | undefined> {
    await this.beforeCommand?.();
    return (await this.redis.hget(runBlockKeys(runId).state, "blk")) || undefined;
  }

  /** Read fixed-size handoff state, optionally fenced to one block, without blocker collections. */
  async readBlockHandoff(runId: string, expectedBlockId?: string): Promise<HandoffState> {
    await this.beforeCommand?.();
    const keys = runBlockKeys(runId);
    const [blockId, handoff, terminal] = await this.redis.hmget(keys.state, "blk", "hs", "term");
    if (expectedBlockId !== undefined && (blockId !== expectedBlockId || terminal === "1")) {
      return "none";
    }
    return decodeHandoff(handoff ?? undefined);
  }

  async readBlockState(runId: string): Promise<BlockState> {
    const keys = runBlockKeys(runId);
    for (;;) {
      const pendingIds: string[] = [],
        deliveredIds: string[] = [];
      const seenPending = new Set<string>(),
        seenDelivered = new Set<string>();
      const edges: BlockStateEdge[] = [];
      let revision = "",
        cutoff = "0",
        edgeOffset = 0,
        earlyAfter = "";
      let snapshot: Pick<BlockState, "blockId" | "handoff" | "terminal"> | undefined;
      for (;;) {
        const reply = await this.#call(
          "runReadBlockState",
          [keys.edge, keys.state, keys.edgeIndex, keys.doneOrder, keys.earlyOrder],
          snapshot ? "page" : "start",
          revision,
          cutoff,
          String(edgeOffset),
          earlyAfter
        );
        if (reply[0] === "stale") break;
        if (!snapshot) {
          revision = reply[1]!;
          cutoff = reply[2]!;
          snapshot = {
            blockId: reply[3] || undefined,
            handoff: decodeHandoff(reply[4]),
            terminal: reply[5] === "1",
          };
        }
        const edgeCount = Number(reply[6]),
          earlyCount = Number(reply[7]);
        let cursor = 8;
        for (let i = 0; i < edgeCount; i++, cursor += 3) {
          const edgeJson = reply[cursor + 1];
          if (!edgeJson) throw new Error(`readBlockState(${runId}): missing edge payload`);
          const stored = JSON.parse(edgeJson) as BlockEdge;
          edges.push({ ...stored, edgeId: reply[cursor]! });
          const delivered = reply[cursor + 2] === "1";
          const seen = delivered ? seenDelivered : seenPending;
          if (!seen.has(stored.waitpointId)) {
            seen.add(stored.waitpointId);
            (delivered ? deliveredIds : pendingIds).push(stored.waitpointId);
          }
        }
        for (let i = 0; i < earlyCount; i++) {
          const id = reply[cursor + i * 2]!;
          if (!seenDelivered.has(id)) {
            seenDelivered.add(id);
            deliveredIds.push(id);
          }
          earlyAfter = reply[cursor + i * 2 + 1]!;
        }
        edgeOffset += edgeCount;
        if (edgeCount < RUN_CLEANUP_PAGE_SIZE && earlyCount < RUN_CLEANUP_PAGE_SIZE) {
          return { ...snapshot, pendingIds, deliveredIds, edges };
        }
      }
    }
  }

  /**
   * Drain one cycle's edges, or clear the run entirely when no edge ids are given.
   *
   * The selective form RECONCILES: any pending or delivered entry that no surviving edge
   * references goes too, not only the named ones. See runClear in scripts.ts for why.
   *
   * This low-level exact-block operation does not consult the handoff obligation. A full clear
   * also removes the cleanup fence. Its caller must already own lifecycle and legacy-edge cleanup;
   * failed-attempt recovery instead retains withdrawal evidence and finalizes the fence last.
   * `cleanupRunBlockState` supplies the handoff gate for its lifecycle callers.
   */
  async clearBlockState(args: {
    runId: string;
    /**
     * The block this clear belongs to. REQUIRED and compared inside the script: every clear
     * here is destructive, and a drain is issued as a SECOND call after an acknowledgement
     * fenced only the first, so a rollover landing between them would otherwise have the new
     * block's state deleted by the old block's late drain. Edge identity cannot serve as the
     * fence, because a new block may reuse the previous one's exact edge fields.
     */
    blockId: string;
    edgeIds?: string[];
  }): Promise<{
    outcome: "cleared" | "drained" | "noop" | "stale" | "terminal";
    currentBlockId?: string;
  }> {
    // `omitted` and `explicitly empty` must not collapse onto each other: the Lua's
    // n === 0 means "clear the whole run", so an omitted edgeIds stays the terminal clear,
    // but a caller that computed zero edges to drain gets a genuine no-op that never
    // reaches Redis.
    if (args.edgeIds && args.edgeIds.length === 0) {
      return { outcome: "noop" };
    }

    const keys = runBlockKeys(args.runId);
    const edgeIds = args.edgeIds ?? [];

    let result: Awaited<ReturnType<WaitpointStoreCoordinator["clearBlockState"]>>;
    for (let offset = 0; offset < Math.max(1, edgeIds.length); offset += RUN_CLEANUP_PAGE_SIZE) {
      const page = edgeIds.slice(offset, offset + RUN_CLEANUP_PAGE_SIZE);
      const reply = await this.#call(
        "runClear",
        [
          keys.pend,
          keys.done,
          keys.edge,
          keys.state,
          keys.refs,
          keys.edgeIndex,
          keys.doneOrder,
          keys.early,
          keys.earlyOrder,
        ],
        args.blockId,
        String(page.length),
        ...page
      );
      result = {
        outcome: reply[0] as "cleared" | "drained" | "stale" | "terminal",
        currentBlockId: reply[1] || undefined,
      };
      if (result.outcome === "stale" || result.outcome === "terminal") return result;
    }
    return result!;
  }

  // ---------------------------------------------------------------------------
  // Fanout
  // ---------------------------------------------------------------------------

  /**
   * Take or renew the claim on one waitpoint's fanout entry and read one bounded page of
   * watchers. The page is not consumed: it stays re-readable until `acknowledgeFanoutPage`
   * trims it.
   */
  async claimFanoutPage(args: {
    waitpointId: string;
    workerId: string;
    pageSize: number;
    leaseMs: number;
    now?: number;
  }): Promise<FanoutClaim> {
    const keys = waitpointKeys(args.waitpointId);

    const reply = await this.#call(
      "wpFanoutClaim",
      [keys.record, keys.watchers, keys.queue, keys.fanout],
      args.workerId,
      String(args.now ?? this.clock()),
      String(args.leaseMs),
      String(args.pageSize)
    );

    switch (reply[0]) {
      case "absent":
        return { outcome: "absent", reason: reply[1] === "no-record" ? "no-record" : "completed" };
      case "pending-record":
        return { outcome: "pending-record" };
      case "notdue":
        return { outcome: "notdue", notBefore: Number(reply[1]) };
      case "done":
        return { outcome: "done" };
      case "quarantined":
        return { outcome: "quarantined", failures: Number(reply[1] ?? 0) };
      case "busy":
        return { outcome: "busy", owner: reply[1] ?? "", leaseExpiresAt: Number(reply[2] ?? 0) };
      case "claimed":
        break;
      default:
        throw new Error(`claimFanoutPage(${args.waitpointId}): unexpected outcome ${reply[0]}`);
    }

    const epoch = reply[6];
    if (!epoch) {
      throw new Error(`claimFanoutPage(${args.waitpointId}): claim returned no fence token`);
    }

    const completedByTaskRunId = reply[7] || undefined;
    const pageLength = Number(reply[8]);
    const page: FanoutPageEntry[] = [];
    for (let i = 0; i < pageLength; i++) {
      const field = reply[9 + i * 2];
      if (field === undefined) {
        throw new Error(
          `claimFanoutPage(${args.waitpointId}): missing watcher field at reply index ${9 + i * 2}`
        );
      }
      page.push({ field, watcher: parseJson<WatcherEntry>(reply[9 + i * 2 + 1]) });
    }

    return {
      outcome: "claimed",
      completion: parseJson<WaitpointCompletion>(reply[1]),
      reclaimed: reply[2] === "1",
      attempts: Number(reply[3]),
      completedAtMs: Number(reply[4]),
      failures: Number(reply[5]),
      epoch,
      completedByTaskRunId,
      record: parseJson<WaitpointRecordInput>(reply[9 + pageLength * 2]),
      page,
    };
  }

  /**
   * Retire `count` watchers from the head of the queue. Draining the last of them marks
   * the fanout done, compacts the watcher state and arms the record's terminal window.
   *
   * `epoch` is the fence token from the claim this page came from. The trim lands at most
   * once per token, so a command resent after its reply was lost reports the first
   * application's outcome instead of retiring a second, undelivered prefix.
   */
  async acknowledgeFanoutPage(args: {
    waitpointId: string;
    workerId: string;
    epoch: string;
    count: number;
    now?: number;
  }): Promise<FanoutAckResult> {
    const keys = waitpointKeys(args.waitpointId);

    const reply = await this.#call(
      "wpFanoutAck",
      [keys.record, keys.watchers, keys.queue, keys.fanout],
      args.workerId,
      args.epoch,
      String(args.count),
      String(args.now ?? this.clock()),
      String(this.terminalRetentionMs)
    );

    switch (reply[0]) {
      case "absent":
        return { outcome: "absent" };
      case "lost":
        return { outcome: "lost", owner: reply[1] ?? "" };
      case "more":
        return { outcome: "more", remaining: Number(reply[1]) };
      case "drained":
        return { outcome: "drained", delivered: Number(reply[1]) };
      default:
        throw new Error(
          `acknowledgeFanoutPage(${args.waitpointId}): unexpected outcome ${reply[0]}`
        );
    }
  }

  /**
   * Give the claim back so the entry is reclaimable at once.
   *
   * With `action: "fail"` the outcome is `quarantined` once the consecutive-failure streak
   * reaches `maxFailures`. That decision is made inside the script, behind the same fence,
   * so a worker whose claim has been superseded can neither count a failure against nor
   * quarantine an entry another worker now holds — it is told `lost` and must not touch the
   * discovery index. Repeating the identical failed release counts nothing and reports the
   * first application's streak.
   */
  async releaseFanout(args: {
    waitpointId: string;
    workerId: string;
    /** The fence token from the claim being given back. */
    epoch: string;
    action: FanoutReleaseAction;
    /** Required for `action: "fail"`. The streak length at which the entry is parked. */
    maxFailures?: number;
    /** Required for `action: "fail"`. The backoff curve the script applies. */
    retryPolicy?: { baseDelayMs: number; maxDelayMs: number };
    now?: number;
  }): Promise<FanoutReleaseResult> {
    const keys = waitpointKeys(args.waitpointId);

    if (args.action === "fail") {
      if (!(args.maxFailures && args.maxFailures >= 1)) {
        throw new Error("releaseFanout: action 'fail' requires a maxFailures >= 1");
      }
      if (!args.retryPolicy) {
        throw new Error("releaseFanout: action 'fail' requires a retryPolicy");
      }
    }

    const reply = await this.#call(
      "wpFanoutRelease",
      [keys.fanout],
      args.workerId,
      args.epoch,
      String(args.now ?? this.clock()),
      args.action,
      String(args.maxFailures ?? 0),
      String(args.retryPolicy?.baseDelayMs ?? 0),
      String(args.retryPolicy?.maxDelayMs ?? 0)
    );

    switch (reply[0]) {
      case "absent":
        return { outcome: "absent" };
      case "lost":
        return { outcome: "lost", owner: reply[1] ?? "" };
      case "released":
      case "quarantined":
        return {
          outcome: reply[0],
          failures: Number(reply[1] ?? 0),
          notBefore: Number(reply[2] ?? 0),
        };
      default:
        throw new Error(`releaseFanout(${args.waitpointId}): unexpected outcome ${reply[0]}`);
    }
  }

  /**
   * File a waitpoint for a fanout visit at `dueAtMs`, unconditionally.
   *
   * Only for a caller that has just CREATED the work, and therefore knows no schedule
   * exists to be trampled. A worker rescheduling an entry it merely observed must use
   * {@link rescheduleFanoutVisit}, which is fenced.
   */
  async scheduleFanoutVisit(waitpointId: string, dueAtMs: number): Promise<void> {
    await this.#fanoutIndex(waitpointId, "add", { score: dueAtMs });
  }

  /**
   * Move an EXISTING entry's visit no earlier than `dueAtMs`.
   *
   * The fenced form, for every worker-initiated reschedule. It never adds and never lowers,
   * so a worker overtaken between reading the fanout entry and writing the index can
   * neither resurrect a hint another worker retired nor pull a newer owner's retry earlier.
   * See the `reschedule` op in scripts.ts.
   */
  async rescheduleFanoutVisit(waitpointId: string, notBeforeMs: number): Promise<void> {
    await this.#fanoutIndex(waitpointId, "reschedule", { score: notBeforeMs });
  }

  /**
   * Repair an EXISTING entry's index score to a time just read out of the fanout entry.
   *
   * The index is advisory: the entry's own `notBefore` is what gates a claim, so a score
   * that ends up early costs a wasted probe and never an early claim. That is why this may
   * lower a score where {@link rescheduleFanoutVisit} may not — the value is authoritative,
   * not a stale worker's guess. It still cannot add, so it cannot resurrect a retired entry.
   */
  async repairFanoutSchedule(waitpointId: string, notBeforeMs: number): Promise<void> {
    await this.#fanoutIndex(waitpointId, "repair", { score: notBeforeMs });
  }

  /** Move an entry out of the due index and into quarantine, atomically. */
  async quarantineFanoutEntry(waitpointId: string, now?: number): Promise<void> {
    await this.#fanoutIndex(waitpointId, "quarantine", { score: now ?? this.clock() });
  }

  async dropFanoutHint(waitpointId: string): Promise<void> {
    await this.#dropFanoutHint(waitpointId);
  }

  /**
   * A bounded page of waitpoint ids due for a fanout visit in one partition. The limit is
   * mandatory, so the reply size never tracks the backlog depth.
   */
  async dueFanoutEntries(args: {
    partition: number;
    limit: number;
    now?: number;
  }): Promise<string[]> {
    const reply = await this.#fanoutIndexForPartition(args.partition, "due", {
      score: args.now ?? this.clock(),
      limit: args.limit,
    });
    return reply.slice(2, 2 + Number(reply[1]));
  }

  /** Aggregate backlog across every partition, for the operational gauges. */
  async fanoutBacklog(): Promise<FanoutBacklog> {
    let due = 0;
    let quarantined = 0;
    let oldestDueAtMs: number | undefined;

    for (let partition = 0; partition < FANOUT_PARTITION_COUNT; partition++) {
      const reply = await this.#fanoutIndexForPartition(partition, "stats", {});
      due += Number(reply[1]);
      quarantined += Number(reply[3]);
      const oldest = reply[2] ? Number(reply[2]) : undefined;
      if (oldest !== undefined && (oldestDueAtMs === undefined || oldest < oldestDueAtMs)) {
        oldestDueAtMs = oldest;
      }
    }

    return { due, oldestDueAtMs, quarantined };
  }

  /** Counts and fanout state for one waitpoint. Never returns the watcher set. */
  async describeWaitpoint(waitpointId: string): Promise<WaitpointDiagnostics> {
    const keys = waitpointKeys(waitpointId);
    const reply = await this.#call("wpDescribe", [
      keys.record,
      keys.watchers,
      keys.queue,
      keys.fanout,
    ]);

    if (reply[0] === "missing") {
      return { outcome: "missing" };
    }

    return {
      outcome: "exists",
      status: reply[1] === "COMPLETED" ? "COMPLETED" : "PENDING",
      recordTtlMs: Number(reply[2]),
      liveWatchers: Number(reply[3]),
      queuedWatchers: Number(reply[4]),
      fanout: decodeFanoutState(reply[5]),
      fanoutOwner: reply[6] || undefined,
      fanoutLeaseExpiresAt: Number(reply[7]),
      fanoutAttempts: Number(reply[8]),
      completedAtMs: Number(reply[9]),
      delivered: Number(reply[10]),
      fanoutFailures: Number(reply[11]),
    };
  }

  /**
   * Read the frozen record + completion for a set of store-resident waitpoints, for the
   * completed-waitpoint resolver.
   *
   * One `HMGET` per id, run concurrently: each waitpoint's keys carry the id as their own hash
   * tag, so a pipeline or `MGET` would span cluster slots and be rejected under cluster mode.
   *
   * Returns ONLY the ids that are present. Absence is distinct from failure and is the caller's to
   * fail loud on: a recognised store id missing from the store is an integrity error, never a
   * signal to fall back to Postgres. A Redis error THROWS out of the `HMGET` and is never seen here
   * as an absent record, so an availability failure can never be mistaken for a missing waitpoint.
   */
  async readCompletedRecords(
    ids: string[],
    runId?: string
  ): Promise<Map<string, WaitpointStoredRecord>> {
    const out = new Map<string, WaitpointStoredRecord>();
    const distinct = [...new Set(ids)];
    await this.beforeCommand?.();
    // Parent snapshot results have no active TTL and survive block acknowledgement/rollover.
    // Read only the IDs owned by the snapshot; original waitpoint records may have expired.
    if (runId && distinct.length > 0) {
      const receipts = await this.redis.hmget(runResultKey(runId), ...distinct);
      for (let i = 0; i < distinct.length; i++) {
        const receipt = parseJson<WaitpointCompletion & { record?: WaitpointRecordInput }>(
          receipts[i] ?? undefined
        );
        if (!receipt?.record) continue;
        const { record, ...completion } = receipt;
        if (record.id !== distinct[i])
          throw new Error(`Parent result has mismatched waitpoint identity: ${distinct[i]}`);
        out.set(distinct[i]!, { status: "COMPLETED", record, completion });
      }
    }

    await pMap(
      distinct,
      async (id) => {
        if (out.has(id)) return;
        const keys = waitpointKeys(id);
        const [r, status, c] = await this.redis.hmget(keys.record, "r", "status", "c");
        // No 'r' means no record hash under this id at all — absent, not an error.
        if (r == null) {
          return;
        }
        const record = parseJson<WaitpointRecordInput>(r);
        if (!record) {
          throw new Error(`Waitpoint ${id} is present in the store with no record blob`);
        }
        out.set(id, {
          status: status === "COMPLETED" ? "COMPLETED" : "PENDING",
          record,
          completion: parseJson<WaitpointCompletion>(c ?? undefined),
        });
      },
      { concurrency: RESOLVER_READ_CONCURRENCY }
    );

    return out;
  }

  #fanoutIndex(
    waitpointId: string,
    op: "add" | "add-nx" | "reschedule" | "repair" | "remove" | "quarantine",
    args: { score?: number }
  ): Promise<string[]> {
    const keys = fanoutIndexKeys(fanoutPartition(waitpointId));
    return this.#call(
      "wpFanoutIndex",
      [keys.due, keys.quarantine],
      op,
      waitpointId,
      String(args.score ?? 0),
      "1"
    );
  }

  #fanoutIndexForPartition(
    partition: number,
    op: "due" | "stats",
    args: { score?: number; limit?: number }
  ): Promise<string[]> {
    const keys = fanoutIndexKeys(partition);
    return this.#call(
      "wpFanoutIndex",
      [keys.due, keys.quarantine],
      op,
      "",
      String(args.score ?? 0),
      String(args.limit ?? 1)
    );
  }

  // Best effort by design. The hint is a discovery accelerator, not the durable record of
  // owed work, so failing to retire one costs a wasted worker visit and nothing else.
  async #dropFanoutHint(waitpointId: string): Promise<void> {
    try {
      await this.#fanoutIndex(waitpointId, "remove", {});
    } catch (error) {
      this.logger.warn("Failed to retire a waitpoint fanout hint", { waitpointId, error });
    }
  }
}
