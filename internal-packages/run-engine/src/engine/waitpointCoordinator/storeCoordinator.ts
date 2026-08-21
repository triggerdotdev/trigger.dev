import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import { assertSingleSlot, waitpointKeys, watcherField } from "./keys.js";
import { registerWaitpointCommands } from "./scripts.js";

/** The values written into a record's `status` field. Uppercase, and never a token. */
export type WaitpointStatus = "PENDING" | "COMPLETED";

/** Every script this coordinator may invoke. The wrapper below is the only entry point. */
type ScriptName =
  | "wpCreateIfAbsent"
  | "wpRegisterOrReport"
  | "wpComplete"
  | "wpIdemReserve"
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
}
