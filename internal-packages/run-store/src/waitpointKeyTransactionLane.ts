import type { PrismaClientOrTransaction } from "@trigger.dev/database";
import type { RunOpsCapableClient } from "./PostgresRunStore.js";

/** Shared with both Prisma URL pools and driver-adapter pools. */
export const WAITPOINT_KEY_TRANSACTION_POOL_SIZE = 4;

/** Both generated Prisma clients support this callback-only transaction surface. */
export interface WaitpointKeyTransactionClient {
  $transaction<R>(
    fn: (tx: RunOpsCapableClient) => Promise<R>,
    options: { timeout: number; maxWait: number }
  ): Promise<R>;
  $disconnect(): Promise<void>;
}

/** Keyed creation ran out of its time budget under load. Retriable: the key makes a retry safe. */
export class WaitpointKeyTransactionBudgetExhaustedError extends Error {
  constructor() {
    super("Keyed waitpoint creation transaction budget exhausted");
    this.name = "WaitpointKeyTransactionBudgetExhaustedError";
  }
}

/** Injected like the store's other metrics, so the package stays free of a metrics dependency. */
export type WaitpointKeyTransactionLaneMetrics = { recordBudgetExhausted(): void };

type Waiter = { enter(release: () => void): void; reject(error: Error): void };
type OrganizationQueue = { organizationId: string; active: boolean; waiters: Set<Waiter> };

/** A bounded isolated pool, opened only by an enabled keyed creator. */
export class WaitpointKeyTransactionLane {
  #client?: WaitpointKeyTransactionClient;
  #active = new Set<Promise<void>>();
  #organizations = new Map<string, OrganizationQueue>();
  #ready = new Set<OrganizationQueue>();
  #closed = false;
  #close?: Promise<void>;

  constructor(
    private readonly createClient: () => WaitpointKeyTransactionClient,
    private readonly metrics?: WaitpointKeyTransactionLaneMetrics
  ) {}

  async run<R>(
    organizationId: string,
    acceptUntil: number,
    fn: (tx: PrismaClientOrTransaction) => Promise<R>
  ): Promise<R> {
    try {
      return await this.#run(organizationId, acceptUntil, fn);
    } catch (error) {
      // Counted once here, so the engine's budget checks inside `fn` are counted too.
      if (error instanceof WaitpointKeyTransactionBudgetExhaustedError)
        this.metrics?.recordBudgetExhausted();
      throw error;
    }
  }

  async #run<R>(
    organizationId: string,
    acceptUntil: number,
    fn: (tx: PrismaClientOrTransaction) => Promise<R>
  ): Promise<R> {
    if (this.#closed) throw new Error("Waitpoint key transaction lane is closed");
    if (!organizationId) throw new Error("Keyed waitpoint creation requires organization context");
    const remaining = acceptUntil - Date.now();
    if (remaining <= 0) throw new WaitpointKeyTransactionBudgetExhaustedError();
    let organization = this.#organizations.get(organizationId);
    if (!organization) {
      organization = { organizationId, active: false, waiters: new Set() };
      this.#organizations.set(organizationId, organization);
    }
    const queue = organization;
    // Sets keep admission, expiry and ready-org rotation constant time. Each org gets one
    // active transaction; when it settles its remaining work rejoins the ready queue's tail.
    const release = await new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        enter: (finish) => {
          clearTimeout(timer);
          resolve(finish);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        queue.waiters.delete(waiter);
        this.#retireIfIdle(queue);
        reject(new WaitpointKeyTransactionBudgetExhaustedError());
      }, remaining);
      queue.waiters.add(waiter);
      if (!queue.active) this.#ready.add(queue);
      this.#drain();
    });
    try {
      const budget = acceptUntil - Date.now();
      if (this.#closed || budget <= 0) throw new WaitpointKeyTransactionBudgetExhaustedError();
      this.#client ??= this.createClient();
      return await this.#client.$transaction(
        async (tx) => {
          const statementBudget = acceptUntil - Date.now();
          if (statementBudget <= 0) throw new WaitpointKeyTransactionBudgetExhaustedError();
          // Prisma's callback timeout does not cancel a running PG query. Bound the first
          // advisory-lock wait at the server too. These are transaction-local, per-statement
          // limits; the caller's creation deadline still fences later publication.
          const timeout = `${statementBudget}ms`;
          await tx.$queryRaw`SELECT set_config('lock_timeout', ${timeout}, true), set_config('statement_timeout', ${timeout}, true)`;
          return fn(tx as unknown as PrismaClientOrTransaction);
        },
        { maxWait: budget, timeout: budget }
      );
    } finally {
      // Release only after the actual Prisma transaction settles, including rollback.
      release();
    }
  }

  #retireIfIdle(organization: OrganizationQueue) {
    if (organization.waiters.size > 0) return;
    this.#ready.delete(organization);
    if (!organization.active) this.#organizations.delete(organization.organizationId);
  }

  #drain() {
    while (!this.#closed && this.#active.size < WAITPOINT_KEY_TRANSACTION_POOL_SIZE) {
      const organization = this.#ready.values().next().value;
      if (!organization) return;
      this.#ready.delete(organization);
      const waiter = organization.waiters.values().next().value!;
      organization.waiters.delete(waiter);
      organization.active = true;
      // Reserve synchronously before resolving the waiter, including across engine instances.
      let finish!: () => void;
      const active = new Promise<void>((resolve) => {
        finish = resolve;
      });
      this.#active.add(active);
      waiter.enter(() => {
        organization.active = false;
        this.#active.delete(active);
        finish();
        if (organization.waiters.size > 0 && !this.#closed) this.#ready.add(organization);
        this.#retireIfIdle(organization);
        this.#drain();
      });
    }
  }

  close(): Promise<void> {
    return (this.#close ??= (async () => {
      this.#closed = true;
      for (const organization of this.#organizations.values()) {
        for (const waiter of organization.waiters)
          waiter.reject(new Error("Waitpoint key transaction lane is closed"));
        organization.waiters.clear();
        this.#retireIfIdle(organization);
      }
      this.#ready.clear();
      await Promise.all(this.#active);
      await this.#client?.$disconnect();
    })());
  }
}

const lanes = new WeakMap<object, WaitpointKeyTransactionLane>();
/** Register the FINAL writer handle; aliases and engine instances reuse the same lane. */
export function registerWaitpointKeyTransactionLane<T extends object>(
  client: T,
  lane: WaitpointKeyTransactionLane
): T {
  lanes.set(client, lane);
  return client;
}
export function waitpointKeyTransactionLaneForClient(
  client: object
): WaitpointKeyTransactionLane | undefined {
  return lanes.get(client);
}
