import type { SessionStreamRecord } from "./types.js";

/**
 * What happens to a record when no consumer is ready for it *right now*.
 *
 * - `queue`: it waits in the route's own queue until a consumer takes it.
 * - `at-arrival`: it goes to a live handler or nowhere. A record that only
 *   means something to the turn that is live when it lands (a stop) is this.
 */
export type RouteDelivery = "queue" | "at-arrival";

/**
 * One route: which kinds it owns, whether it waits for a consumer, and whether
 * a record it never handled has to survive into the next boot.
 *
 * The two properties are independent, and that is the point. Three of the four
 * combinations are meaningful and cover everything `session.in` carries:
 *
 * | delivery | replayable | example |
 * | --- | --- | --- |
 * | `queue` | `true` | a user message: waits for a turn, and a crash must not lose it |
 * | `at-arrival` | `false` | a stop: only the live turn cares, and a replayed one would abort the wrong turn |
 * | `queue` | `false` | a handover signal: can arrive before its consumer is ready, but is meaningless to a later boot |
 *
 * The fourth is a contradiction (discard it when nobody is listening, yet
 * recover it later) and the table rejects it.
 */
export type SessionRoute = {
  /** Unique within a table. */
  name: string;
  delivery: RouteDelivery;
  /**
   * Whether a record this route never handled must be recovered by the next
   * boot. Only `true` holds the resume floor back.
   */
  replayable: boolean;
  /** Record kinds this route owns. Every kind belongs to at most one route. */
  kinds: readonly string[];
};

/**
 * The complete statement of what a channel carries and who owns each kind.
 * Intended to be a literal at the point of use, so "which kinds exist and what
 * happens to each" is answerable by reading one object.
 */
export type SessionRouteTable = {
  /** Extract a record's kind. Returning `undefined` marks it malformed. */
  kindOf: (data: unknown) => string | undefined;
  routes: readonly SessionRoute[];
};

export type RouterDropReason =
  /** No route claims this kind: nothing on this boot can consume it. */
  | "unroutable"
  /** No usable kind on the record at all. */
  | "malformed"
  /**
   * A non-replayable record inside the replay window. It was already observed
   * by a previous run, and its route has declared that a later boot has no use
   * for it.
   */
  | "replayed"
  /** An `at-arrival` record with no handler attached right now. */
  | "no-handler";

export type RouterDecision =
  /** Handed to a consumer that was already waiting, or to a live handler. */
  | { action: "deliver"; route: string }
  /** Parked in the route's queue for a future consumer. */
  | { action: "queue"; route: string }
  | { action: "drop"; route?: string; reason: RouterDropReason };

/**
 * The two numbers a turn boundary publishes, and that a boot reads back.
 *
 * `resumeFrom` is the floor: every record at or below it was terminally
 * handled, so a boot subscribes from just past it. `appliedThrough` is the end
 * of the replay window: the highest sequence a previous run observed. Records
 * at or below it are being re-read rather than arriving live.
 */
export type RouterCheckpoint = {
  resumeFrom?: number;
  appliedThrough?: number;
};

type QueueWaiter = {
  resolve: (record: SessionStreamRecord | undefined) => void;
  timer?: ReturnType<typeof setTimeout>;
};

type RouteHandler = (record: SessionStreamRecord) => void;

/**
 * One route's live state: its queue of records nobody has taken yet, the
 * consumers waiting for the next one, and any attached push handlers.
 *
 * An `at-arrival` route never fills `queue`; a route that is not `replayable`
 * fills it but is skipped when the floor is computed.
 */
class RouteState {
  readonly queue: SessionStreamRecord[] = [];
  readonly waiters: QueueWaiter[] = [];
  readonly handlers = new Set<RouteHandler>();

  constructor(readonly route: SessionRoute) {}

  /**
   * Lowest sequence a *later boot* would still have to recover. A route that
   * is not replayable never holds anything back, however much it has queued.
   */
  earliestUnrecovered(): number | undefined {
    if (!this.route.replayable) return undefined;
    return this.queue.length > 0 ? this.queue[0]!.seqNum : undefined;
  }
}

/**
 * Reads one session channel and gives every record exactly one destination.
 *
 * The channel carries records for several independent consumers whose delivery
 * needs differ: a message must be delivered eventually and so can lag
 * arbitrarily far behind the newest record, while a stop only means anything to
 * the turn that is live when it lands. Tracking that with a single scalar
 * cursor is not possible — the true state is always "control applied through
 * X, message Y still owed" — so the router tracks it per route and derives the
 * published numbers from route state:
 *
 * - the resume floor is held back only by records a later boot would still have
 *   to recover, which is exactly the queued records on replayable routes;
 * - a record whose route has declared it not replayable is never re-applied
 *   after a resume, because the route said a later boot has no use for it;
 * - a record with no route is terminal by classification, so it never enters a
 *   queue and cannot park at the head of one.
 *
 * Those three properties are what previously needed a cursor-barrier
 * predicate, a drop predicate with a second published header, and a
 * discard-the-unclaimed drain respectively.
 */
export class SessionChannelRouter {
  #routes = new Map<string, RouteState>();
  #kindToRoute = new Map<string, string>();
  #highestSeq: number | undefined;
  #resumeFrom: number | undefined;
  #appliedThrough: number | undefined;
  #onDrop?: (record: SessionStreamRecord, reason: RouterDropReason, route?: string) => void;

  constructor(
    private table: SessionRouteTable,
    options?: {
      /** Called for every dropped record. Reporting only; never load-bearing. */
      onDrop?: (record: SessionStreamRecord, reason: RouterDropReason, route?: string) => void;
    }
  ) {
    for (const route of table.routes) {
      if (this.#routes.has(route.name)) {
        throw new Error(`Duplicate route name "${route.name}" in session route table`);
      }
      if (route.delivery === "at-arrival" && route.replayable) {
        throw new Error(
          `Route "${route.name}" is at-arrival and replayable, which cannot both hold: a record discarded because nobody was listening cannot also be recovered later`
        );
      }
      this.#routes.set(route.name, new RouteState(route));
      for (const kind of route.kinds) {
        const existing = this.#kindToRoute.get(kind);
        if (existing) {
          throw new Error(
            `Kind "${kind}" is claimed by both "${existing}" and "${route.name}" in session route table`
          );
        }
        this.#kindToRoute.set(kind, route.name);
      }
    }
    this.#onDrop = options?.onDrop;
  }

  /**
   * Seed the router from a previous run's turn boundary.
   *
   * An absent `appliedThrough` is treated as equal to the floor rather than as
   * "nothing was applied". A boundary written before that value existed still
   * tells us everything at or below the floor was terminal, and for anything
   * above it the conservative choice for an `at-arrival` record is to not apply
   * it: a missed stop is recoverable, while a stop applied to the wrong turn
   * kills a live answer.
   */
  restore(checkpoint: RouterCheckpoint): void {
    this.#resumeFrom = checkpoint.resumeFrom;
    this.#appliedThrough = checkpoint.appliedThrough ?? checkpoint.resumeFrom;
    if (this.#resumeFrom !== undefined) {
      this.#highestSeq = this.#resumeFrom;
    }
  }

  /** Where a boot should subscribe from: just past this sequence. */
  resumeFrom(): number | undefined {
    return this.#resumeFrom;
  }

  /**
   * Classify one record and act on it. The record's destination is decided
   * here, once, and never by whichever consumer happens to be waiting.
   *
   * Queued routes serve a waiting consumer before a push handler, so a handler
   * can never take a record out from under a consumer that is actively awaiting
   * one. A record handed straight to either never enters the queue, so it never
   * holds the floor back.
   */
  ingest(record: SessionStreamRecord): RouterDecision {
    if (Number.isFinite(record.seqNum)) {
      if (this.#highestSeq === undefined || record.seqNum > this.#highestSeq) {
        this.#highestSeq = record.seqNum;
      }
    }

    const kind = this.#kindOf(record.data);
    if (kind === undefined) {
      return this.#drop(record, "malformed");
    }

    const routeName = this.#kindToRoute.get(kind);
    const state = routeName ? this.#routes.get(routeName) : undefined;
    if (!state || !routeName) {
      return this.#drop(record, "unroutable");
    }

    if (
      !state.route.replayable &&
      this.#appliedThrough !== undefined &&
      record.seqNum <= this.#appliedThrough
    ) {
      return this.#drop(record, "replayed", routeName);
    }

    if (
      state.route.delivery === "at-arrival" &&
      state.handlers.size === 0 &&
      state.waiters.length === 0
    ) {
      return this.#drop(record, "no-handler", routeName);
    }

    const waiter = state.waiters.shift();
    if (waiter) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(record);
      return { action: "deliver", route: routeName };
    }

    if (state.handlers.size > 0) {
      this.#invokeHandlers(state, record);
      return { action: "deliver", route: routeName };
    }

    state.queue.push(record);
    return { action: "queue", route: routeName };
  }

  #kindOf(data: unknown): string | undefined {
    try {
      const kind = this.table.kindOf(data);
      return typeof kind === "string" && kind.length > 0 ? kind : undefined;
    } catch {
      return undefined;
    }
  }

  #drop(record: SessionStreamRecord, reason: RouterDropReason, route?: string): RouterDecision {
    try {
      this.#onDrop?.(record, reason, route);
    } catch {
      void 0;
    }
    return { action: "drop", route, reason };
  }

  #invokeHandlers(state: RouteState, record: SessionStreamRecord): void {
    for (const handler of state.handlers) {
      try {
        handler(record);
      } catch {
        void 0;
      }
    }
  }

  /**
   * The highest sequence that can be resumed past without losing anything.
   *
   * Held back below the earliest record still queued anywhere, because those
   * are exactly the records a replay has to recover. Everything else the
   * router has seen was terminally decided, so the floor is free to sit at the
   * high water when every queue is empty.
   */
  resumeFloor(): number | undefined {
    if (this.#highestSeq === undefined) return undefined;

    let earliestPending = Infinity;
    for (const state of this.#routes.values()) {
      const pending = state.earliestUnrecovered();
      if (pending !== undefined) earliestPending = Math.min(earliestPending, pending);
    }

    if (earliestPending === Infinity) return this.#highestSeq;

    const floor = Math.min(this.#highestSeq, earliestPending - 1);
    return floor >= 0 ? floor : undefined;
  }

  /**
   * The high water: highest sequence observed, never held back. Published as
   * the end of the replay window so the next boot can tell a re-read
   * `at-arrival` record from one arriving live.
   */
  appliedThrough(): number | undefined {
    return this.#highestSeq;
  }

  /** Both published numbers for a turn boundary. */
  checkpoint(): RouterCheckpoint {
    return { resumeFrom: this.resumeFloor(), appliedThrough: this.appliedThrough() };
  }

  #stateOrThrow(name: string): RouteState {
    const state = this.#routes.get(name);
    if (!state) throw new Error(`Unknown session route "${name}"`);
    return state;
  }

  /**
   * Attach a push handler. A `queued` route with a handler attached delivers
   * straight to it instead of queueing; an `at-arrival` route discards records
   * whenever no handler is attached.
   *
   * Attaching re-offers anything already queued, so a consumer that attaches
   * after records have piled up still sees them in order.
   */
  on(name: string, handler: RouteHandler): { off: () => void } {
    const state = this.#stateOrThrow(name);
    state.handlers.add(handler);

    if (state.queue.length > 0) {
      const pending = state.queue.splice(0, state.queue.length);
      for (const record of pending) {
        try {
          handler(record);
        } catch {
          void 0;
        }
      }
    }

    return {
      off: () => {
        state.handlers.delete(handler);
      },
    };
  }

  /** Whether an `at-arrival` route currently has anywhere to deliver. */
  hasHandler(name: string): boolean {
    return this.#stateOrThrow(name).handlers.size > 0;
  }

  /**
   * Take the next record on a route.
   *
   * `timeoutMs: 0` is a non-blocking take. Omitted means wait indefinitely.
   * Resolves `undefined` on timeout. An `at-arrival` route delivers to a
   * waiting caller when one is already parked here, which is what makes a pull
   * consumer possible on such a route without weakening the discard rule.
   */
  next(name: string, options?: { timeoutMs?: number }): Promise<SessionStreamRecord | undefined> {
    const state = this.#stateOrThrow(name);
    const queued = state.queue.shift();
    if (queued) return Promise.resolve(queued);

    if (options?.timeoutMs === 0) return Promise.resolve(undefined);

    return new Promise<SessionStreamRecord | undefined>((resolve) => {
      const waiter: QueueWaiter = { resolve };
      if (options?.timeoutMs !== undefined) {
        waiter.timer = setTimeout(() => {
          const index = state.waiters.indexOf(waiter);
          if (index !== -1) state.waiters.splice(index, 1);
          resolve(undefined);
        }, options.timeoutMs);
      }
      state.waiters.push(waiter);
    });
  }

  /** Head of a route's queue without consuming it. */
  peek(name: string): SessionStreamRecord | undefined {
    return this.#stateOrThrow(name).queue[0];
  }

  /**
   * Whether a route has anything queued. Exact, because it reads that route's
   * own queue rather than the head of a buffer shared with every other kind on
   * the channel.
   */
  hasPending(name: string): boolean {
    return this.#stateOrThrow(name).queue.length > 0;
  }

  /** Number of records queued on a route. Diagnostic use. */
  pendingCount(name: string): number {
    return this.#stateOrThrow(name).queue.length;
  }

  /**
   * Discard whatever one route has queued and wake its waiters empty.
   *
   * Closes a consumer window: a route that is not replayable has nothing owed
   * to a later boot, so once its window is over anything still queued on it is
   * dead and must not sit at the head of the queue for the rest of the run.
   */
  clearRoute(name: string): void {
    const state = this.#stateOrThrow(name);
    state.queue.length = 0;
    for (const waiter of state.waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(undefined);
    }
    state.waiters.length = 0;
  }

  /** Drop every waiter and queue. Called between task executions. */
  reset(): void {
    for (const state of this.#routes.values()) {
      state.queue.length = 0;
      state.handlers.clear();
      for (const waiter of state.waiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(undefined);
      }
      state.waiters.length = 0;
    }
    this.#highestSeq = undefined;
    this.#resumeFrom = undefined;
    this.#appliedThrough = undefined;
  }
}
