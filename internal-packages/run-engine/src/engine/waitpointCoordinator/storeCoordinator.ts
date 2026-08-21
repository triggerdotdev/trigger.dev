import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import {
  assertSingleSlot,
  edgeField,
  idempotencyKey,
  runBlockKeys,
  waitpointKeys,
  watcherField,
} from "./keys.js";
import { registerWaitpointCommands } from "./scripts.js";

/** The values written into a record's `status` field. Uppercase, and never a token. */
export type WaitpointStatus = "PENDING" | "COMPLETED";

/** Every script this coordinator may invoke. The wrapper below is the only entry point. */
type ScriptName =
  | "wpCreateIfAbsent"
  | "wpRegisterOrReport"
  | "wpComplete"
  | "wpIdemReserve"
  | "wpDiscard"
  | "runAbsorbBlockers"
  | "runDeliverCompletion"
  | "runReadBlockState"
  | "runClear";

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

export type WatcherEntry = {
  runId: string;
  batchIndex?: number;
  spanIdToComplete?: string;
  createdAt: string;
};

/**
 * Marks an edge as reported COMPLETED with no completion envelope — the shape a
 * FINISHED-healing create can produce. Distinct from `undefined` (never reported), so the
 * pending decision can key on outcome alone rather than on envelope presence.
 */
export const EMPTY_REPORTED_MARKER = Symbol("waitpoint-reported-no-envelope");

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
  | { outcome: "completed"; completion?: WaitpointCompletion };

export type CompleteResult = {
  outcome: "completed" | "already";
  completion?: WaitpointCompletion;
  watchers: WatcherEntry[];
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
  /** Set when the register step already reported this waitpoint COMPLETED. */
  reported?: WaitpointCompletion | typeof EMPTY_REPORTED_MARKER;
};

export type AbsorbResult = {
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
  alreadyDelivered: Array<{ waitpointId: string; completion?: WaitpointCompletion }>;
};

// absorbBlockers strips `reported` before writing the edge blob, so a value read back
// here can never carry it — Omit says so instead of inheriting a field that is always
// undefined.
export type BlockStateEdge = Omit<BlockEdge, "reported"> & { edgeId: string };

export type BlockState = {
  pendingIds: string[];
  deliveredIds: string[];
  edges: BlockStateEdge[];
};

export class WaitpointNotFoundError extends Error {
  constructor(waitpointId: string) {
    super(`Waitpoint ${waitpointId} is not present in the store`);
    this.name = "WaitpointNotFoundError";
  }
}

export type WaitpointStoreCoordinatorOptions = {
  redisOptions: RedisOptions;
  logger?: Logger;
};

// Lua returns '' for an absent value, never nil, because every reply slot is coerced to
// keep the array from truncating. So a nullish check would not fire and JSON.parse('')
// throws. One helper, used at every decode site.
function parseJson<T>(raw: string | undefined): T | undefined {
  return raw ? (JSON.parse(raw) as T) : undefined;
}

export class WaitpointStoreCoordinator {
  private readonly redis: Redis;
  private readonly logger: Logger;
  #quit?: Promise<void>;

  constructor(options: WaitpointStoreCoordinatorOptions) {
    this.logger = options.logger ?? new Logger("WaitpointStoreCoordinator", "debug");
    this.redis = createRedisClient(options.redisOptions, {
      onError: (error) =>
        this.logger.error("WaitpointStoreCoordinator redis client error", { error }),
    });
    registerWaitpointCommands(this.redis);
  }

  // Idempotent and error-swallowing: every test calls this in a finally, and a double quit
  // must never mask the real assertion failure.
  async quit(): Promise<void> {
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
    const command = this.redis[script] as (...args: string[]) => Promise<string[]>;
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
    const keys = waitpointKeys(args.record.id);

    const reply = await this.#call(
      "wpCreateIfAbsent",
      [keys.record],
      JSON.stringify(args.record),
      args.status,
      args.completion ? JSON.stringify(args.completion) : ""
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
    batchIndex?: number | null;
    spanIdToComplete?: string;
    createdAt: string;
  }): Promise<RegisterOrReportResult> {
    const keys = waitpointKeys(args.waitpointId);

    // batchIndex is nullable at the boundary (matching the column) and undefined inside,
    // because JSON.stringify drops an undefined field but keeps a null one.
    const watcher: WatcherEntry = {
      runId: args.runId,
      batchIndex: args.batchIndex ?? undefined,
      spanIdToComplete: args.spanIdToComplete,
      createdAt: args.createdAt,
    };

    const reply = await this.#call(
      "wpRegisterOrReport",
      [keys.record, keys.watchers],
      watcherField(args.runId, args.batchIndex),
      JSON.stringify(watcher)
    );

    if (reply[0] === "missing") {
      throw new WaitpointNotFoundError(args.waitpointId);
    }
    if (reply[0] === "completed") {
      return { outcome: "completed", completion: parseJson<WaitpointCompletion>(reply[1]) };
    }

    return { outcome: "registered" };
  }

  async complete(args: {
    waitpointId: string;
    completion: WaitpointCompletion;
  }): Promise<CompleteResult> {
    const keys = waitpointKeys(args.waitpointId);

    const reply = await this.#call(
      "wpComplete",
      [keys.record, keys.watchers],
      JSON.stringify(args.completion)
    );

    if (reply[0] === "missing") {
      throw new WaitpointNotFoundError(args.waitpointId);
    }

    return {
      outcome: reply[0] as "completed" | "already",
      completion: parseJson<WaitpointCompletion>(reply[1]),
      watchers: reply.slice(2).map((entry) => JSON.parse(entry) as WatcherEntry),
    };
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
  }): Promise<{ waitpointId: string; created: boolean }> {
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
      // watcher can reference it. Both keys share the record's tag.
      const keys = waitpointKeys(args.record.id);
      await this.#call("wpDiscard", [keys.record, keys.watchers]);
    }

    return { waitpointId: winner, created: false };
  }

  async absorbBlockers(args: { runId: string; edges: BlockEdge[] }): Promise<AbsorbResult> {
    const keys = runBlockKeys(args.runId);

    // No fast path for an empty list: storePendingTotal is defined as the run's WHOLE
    // store-resident pending set, so it has to be read even when nothing is requested.
    const argv: string[] = [String(args.edges.length)];
    for (const item of args.edges) {
      const { reported, ...stored } = item;
      const reportedFlag = reported !== undefined ? "1" : "0";
      const reportedJson =
        reported !== undefined && reported !== EMPTY_REPORTED_MARKER
          ? JSON.stringify(reported)
          : "";
      argv.push(
        item.waitpointId,
        edgeField(item.waitpointId, item.batchIndex),
        JSON.stringify(stored),
        reportedFlag,
        reportedJson
      );
    }

    const reply = await this.#call("runAbsorbBlockers", [keys.pend, keys.done, keys.edge], ...argv);

    const alreadyDelivered: AbsorbResult["alreadyDelivered"] = [];
    for (let i = 2; i < reply.length; i += 2) {
      alreadyDelivered.push({
        waitpointId: reply[i]!,
        completion: parseJson<WaitpointCompletion>(reply[i + 1]),
      });
    }

    return {
      pendingOfRequested: Number(reply[0]),
      storePendingTotal: Number(reply[1]),
      alreadyDelivered,
    };
  }

  /**
   * Block a run on a set of waitpoints.
   *
   * Register on every waitpoint's own shard FIRST, then absorb on the run's shard. The
   * order is the protocol: a completion that lands in between finds the watcher already
   * registered, so it delivers onto the run's shard, and the absorb sees that delivery and
   * never marks the waitpoint pending. Reversing the two would open the window where a
   * completion is missed by both steps.
   *
   * The register keys the decision to skip the pending set on OUTCOME, never on whether a
   * completion envelope came back — a waitpoint can be reported COMPLETED with none.
   */
  async registerBlocks(args: { runId: string; edges: BlockEdge[] }): Promise<AbsorbResult> {
    const registered: BlockEdge[] = [];

    for (const item of args.edges) {
      const result = await this.registerOrReport({
        waitpointId: item.waitpointId,
        runId: args.runId,
        batchIndex: item.batchIndex,
        spanIdToComplete: item.spanIdToComplete,
        createdAt: item.createdAt,
      });

      registered.push(
        result.outcome === "completed"
          ? { ...item, reported: result.completion ?? EMPTY_REPORTED_MARKER }
          : item
      );
    }

    return this.absorbBlockers({ runId: args.runId, edges: registered });
  }

  async deliverCompletion(args: {
    runId: string;
    waitpointId: string;
    completion: WaitpointCompletion;
  }): Promise<{ storePendingTotal: number }> {
    const keys = runBlockKeys(args.runId);

    const reply = await this.#call(
      "runDeliverCompletion",
      [keys.pend, keys.done],
      args.waitpointId,
      JSON.stringify(args.completion)
    );

    return { storePendingTotal: Number(reply[0]) };
  }

  async readBlockState(runId: string): Promise<BlockState> {
    const keys = runBlockKeys(runId);
    const reply = await this.#call("runReadBlockState", [keys.pend, keys.done, keys.edge]);

    // Slots 0 and 1 are true element counts, but slot 2 is the FLAT length of the edge
    // HGETALL — two entries per edge, field then value. The cursor arithmetic below relies
    // on that asymmetry, so do not "normalise" it without changing the Lua too.
    const pendCount = Number(reply[0]);
    const doneCount = Number(reply[1]);
    const edgeCount = Number(reply[2]);

    let cursor = 3;
    const pendingIds = reply.slice(cursor, cursor + pendCount);
    cursor += pendCount;
    const deliveredIds = reply.slice(cursor, cursor + doneCount);
    cursor += doneCount;

    const edges: BlockStateEdge[] = [];
    for (let i = 0; i < edgeCount; i += 2) {
      const edgeId = reply[cursor + i]!;
      // An edge value is always a non-empty JSON.stringify, so a missing slot here means
      // the cursor walked off the end of the reply. That must fail loudly, not decode a
      // BlockEdge with no waitpointId — the exact off-by-one this task's arithmetic guards
      // against.
      const edgeJson = reply[cursor + i + 1];
      if (!edgeJson) {
        throw new Error(
          `readBlockState(${runId}): missing edge payload at reply index ${cursor + i + 1}`
        );
      }
      const stored = JSON.parse(edgeJson) as BlockEdge;
      edges.push({ ...stored, edgeId });
    }

    return { pendingIds, deliveredIds, edges };
  }

  /**
   * Drain one cycle's edges, or clear the run entirely when no edge ids are given.
   *
   * The selective form RECONCILES: any pending or delivered entry that no surviving edge
   * references goes too, not only the named ones. See runClear in scripts.ts for why.
   */
  async clearBlockState(args: {
    runId: string;
    edgeIds?: string[];
  }): Promise<{ outcome: "cleared" | "drained" | "noop" }> {
    // `omitted` and `explicitly empty` must not collapse onto each other: the Lua's
    // n === 0 means "clear the whole run", so an omitted edgeIds stays the terminal clear,
    // but a caller that computed zero edges to drain gets a genuine no-op that never
    // reaches Redis.
    if (args.edgeIds && args.edgeIds.length === 0) {
      return { outcome: "noop" };
    }

    const keys = runBlockKeys(args.runId);
    const edgeIds = args.edgeIds ?? [];

    const reply = await this.#call(
      "runClear",
      [keys.pend, keys.done, keys.edge],
      String(edgeIds.length),
      ...edgeIds
    );

    return { outcome: reply[0] as "cleared" | "drained" };
  }
}
