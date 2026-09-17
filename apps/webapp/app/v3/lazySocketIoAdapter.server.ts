import { createAdapter } from "@socket.io/redis-adapter";
import type { Redis } from "ioredis";
import type { Namespace } from "socket.io";
import type { Adapter } from "socket.io-adapter";

type AdapterFactory = (nsp: Namespace) => Adapter;
type CreateAdapterOptions = Parameters<typeof createAdapter>[2];

export type LazySocketIoAdapter = {
  /** Pass as the socket.io `Server`'s `adapter` option. */
  adapter: AdapterFactory;
  /**
   * Opens this namespace's Redis subscriptions. Await it before a socket can
   * join a room, so a broadcast can never arrive at an unsubscribed process.
   * Idempotent, and safe to call concurrently. A failed attempt is retried on
   * the next call rather than being cached.
   */
  activate: (namespaceName: string) => Promise<void>;
  /** True once {@link activate} has been called for the namespace's current adapter. */
  isActivated: (namespaceName: string) => boolean;
  activatedNamespaces: () => string[];
};

/**
 * Activation state for one adapter instance. Completion handlers close over
 * this object rather than a namespace-keyed map, so an activation started by
 * an adapter that has since been replaced can only ever mutate its own,
 * orphaned state and never the replacement's.
 */
type NamespaceState = {
  queue: Array<() => unknown>;
  activation: Promise<void> | undefined;
  ready: boolean;
};

/**
 * `subClient` calls the adapter makes at construction time that we hold back.
 * Everything else, including the `pmessageBuffer` / `messageBuffer` listener
 * registration, still runs eagerly so no message can be dropped in the gap
 * between subscribing and the handler being attached.
 */
const DEFERRED_METHODS = new Set(["subscribe", "psubscribe"]);

const isLocalOnly = (opts: unknown) =>
  Boolean((opts as { flags?: { local?: boolean } } | undefined)?.flags?.local);

/**
 * Adapter operations that publish a request and then wait on replies, keyed
 * to a predicate over the call's arguments saying whether this particular call
 * does. Each one sizes its wait from `serverCount()`, which is `NUMSUB` on the
 * request channel, and assumes the caller is one of those subscribers. An
 * unsubscribed caller would undercount peers (`fetchSockets` on a single
 * active peer sees `numSub === 1` and silently returns only local results) and
 * could not receive replies anyway, having no response-channel subscription.
 * So a call that needs replies activates first, trading a subscription for a
 * correct answer, while a call that cannot need one (`flags.local`) runs as
 * stock and leaves an idle process idle.
 *
 * Not listed: `serverSideEmit` without an ack publishes with no `requestId`,
 * so peers never reply, and with an ack it delegates to the wrapped
 * `serverSideEmitWithAck`. `serverCount` gets its own wrapper below, since it
 * must keep counting the caller without being made to subscribe.
 */
export const RESPONSE_DEPENDENT_METHODS: Readonly<
  Record<string, (args: readonly unknown[]) => boolean>
> = {
  fetchSockets: ([opts]) => !isLocalOnly(opts),
  allRooms: () => true,
  serverSideEmitWithAck: () => true,
  broadcastWithAck: ([, opts]) => !isLocalOnly(opts),
};

/**
 * Rejects if `promise` has not settled within `ms`. The underlying work keeps
 * running, so a slow activation still completes and benefits the next caller;
 * only this caller stops waiting.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Wraps `@socket.io/redis-adapter` so a process only subscribes to a
 * namespace's Redis channels once it actually serves a connection on that
 * namespace, or issues an adapter operation that needs replies.
 *
 * Fan-out is O(subscribing processes), so a process holding no sockets for a
 * namespace costs every publisher a delivery it will only discard. Deferring
 * the subscription keeps each namespace's fan-out to the processes that can
 * act on it, with no deployment-time configuration to keep in sync.
 */
export function createLazySocketIoAdapter(
  pubClient: Redis,
  subClient: Redis,
  opts: CreateAdapterOptions
): LazySocketIoAdapter {
  /** The current adapter's state per namespace name; replaced wholesale on reconstruction. */
  const states = new Map<string, NamespaceState>();

  async function flush(state: NamespaceState) {
    if (state.queue.length === 0) {
      return;
    }

    /** Left in place until every call lands, so a failure retries the whole set. */
    for (const call of state.queue) {
      await call();
    }

    state.queue.length = 0;
  }

  function activateState(state: NamespaceState): Promise<void> {
    if (state.activation) {
      return state.activation;
    }

    const activation = flush(state).then(
      () => {
        state.ready = true;
      },
      (error) => {
        state.activation = undefined;
        throw error;
      }
    );

    state.activation = activation;

    return activation;
  }

  function activate(namespaceName: string): Promise<void> {
    const state = states.get(namespaceName);

    return state ? activateState(state) : Promise.resolve();
  }

  /**
   * socket.io instantiates the adapter with `new`, so this has to be a
   * constructable function. An arrow function throws "not a constructor".
   */
  const adapter = function (nsp: Namespace) {
    /**
     * A fresh state object per construction. A namespace rebuilt under the
     * same name gets its own queue and readiness, and any activation the
     * previous adapter still has in flight settles into that previous object,
     * which nothing consults any more.
     */
    const state: NamespaceState = { queue: [], activation: undefined, ready: false };
    states.set(nsp.name, state);

    const deferredSubClient = new Proxy(subClient, {
      get(target, prop) {
        if (typeof prop === "string" && DEFERRED_METHODS.has(prop)) {
          return (...args: unknown[]) => {
            state.queue.push(() => (target as unknown as Record<string, Function>)[prop](...args));
            return Promise.resolve(0);
          };
        }

        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const instance = createAdapter(pubClient, deferredSubClient as Redis, opts)(nsp);
    const methods = instance as unknown as Record<string, unknown>;

    /**
     * The stock adapter's `serverCount()` always includes the caller, because
     * the caller is always subscribed to the request channel that `NUMSUB`
     * counts. A cold lazy adapter is not, so it adds itself back rather than
     * subscribing just to be counted. Mid-activation, wait for the
     * subscription to land so `NUMSUB` is exact instead of guessing which side
     * of it we are on. Once ready, `NUMSUB` already counts this process.
     *
     * The cold decision is re-checked after the count resolves. The
     * subscription travels on `subClient` and `NUMSUB` on `pubClient`, and
     * Redis orders nothing across connections, so an activation that starts
     * during the read can reach Redis before `NUMSUB` executes and the result
     * would already include this process. Recounting after that activation
     * settles is exact; the extra one is added only when the state stayed cold
     * for the whole read. A rejected activation leaves this process
     * unsubscribed, so it counts as cold.
     */
    const stockServerCount = methods.serverCount;

    if (typeof stockServerCount === "function") {
      const count = () =>
        Promise.resolve((stockServerCount as () => unknown).apply(instance, [])).then(Number);

      const countOnceSubscribed = (activation: Promise<void>) =>
        activation.then(count, () => count().then((peers) => peers + 1));

      methods.serverCount = () => {
        if (state.ready) {
          return count();
        }

        if (state.activation) {
          return countOnceSubscribed(state.activation);
        }

        return count().then((peers) =>
          state.activation ? countOnceSubscribed(state.activation) : peers + 1
        );
      };
    }

    for (const [method, needsReplies] of Object.entries(RESPONSE_DEPENDENT_METHODS)) {
      const original = methods[method];

      if (typeof original !== "function") {
        continue;
      }

      const call = original as (...a: unknown[]) => unknown;

      /**
       * A call that cannot need replies, or one on an already subscribed
       * namespace, delegates synchronously so the sync-returning
       * `broadcastWithAck` keeps its ordering relative to a plain `broadcast`.
       * Only the first reply-needing call pays the async activation. Readiness
       * is this instance's own, never a namesake's.
       */
      methods[method] = (...args: unknown[]) => {
        if (!needsReplies(args) || state.ready) {
          return call.apply(instance, args);
        }

        return activateState(state).then(() => call.apply(instance, args));
      };
    }

    return instance;
  } as unknown as AdapterFactory;

  return {
    adapter,
    activate,
    isActivated: (namespaceName) => Boolean(states.get(namespaceName)?.activation),
    activatedNamespaces: () =>
      Array.from(states.entries())
        .filter(([, state]) => Boolean(state.activation))
        .map(([name]) => name),
  };
}
