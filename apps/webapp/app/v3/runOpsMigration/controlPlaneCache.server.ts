import type {
  BackgroundWorker,
  BackgroundWorkerTask,
  Prisma,
  RuntimeEnvironmentType,
  TaskQueue,
  WorkerDeployment,
} from "@trigger.dev/database";
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";
import type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";

/**
 * Cache policy + invalidation for the cross-DB control-plane resolver.
 *
 * One-way dependency: this module is imported by `controlPlaneResolver.server.ts`;
 * it must NEVER import the resolver. The shared `Resolved*` return types live here
 * so both files reference an identical definition (the resolver re-exports them for
 * consumers).
 *
 * Invalidation note: the underlying `BoundedTtlCache` exposes no public `delete`, so
 * explicit invalidation is implemented with a per-key epoch map. A write stamps the
 * stored value with the key's current epoch; a read returns the value only if its
 * stamped epoch still matches the current epoch, otherwise it is treated as a miss.
 * `invalidate*` bumps the key's epoch, forcing the next read to miss. (If a future
 * rebase gives `BoundedTtlCache` a public `delete`, prefer it and drop the epoch map.)
 */

export const DEFAULT_CP_CACHE_TTL_MS = 30_000;
export const DEFAULT_CP_CACHE_MAX_ENTRIES = 10_000;

export type ResolvedEnv = {
  id: string;
  type: RuntimeEnvironmentType;
  projectId: string;
  organizationId: string;
  archivedAt: Date | null;
  // The parent env's type, or null when this env has no parent. Alerts compute
  // `parentEnvironmentType ?? type` (byte-identical to `parentEnvironment?.type ?? type`).
  parentEnvironmentType: RuntimeEnvironmentType | null;
  // Concurrency + nested ids the run-engine ControlPlaneResolver adapter maps to
  // `ResolvedEngineEnv` (a MinimalAuthenticatedEnvironment superset). Existing app consumers
  // ignore these additive fields.
  maximumConcurrencyLimit: number;
  concurrencyLimitBurstFactor: Prisma.Decimal;
};

/** Mirrors `WorkerDeploymentWithWorkerTasks` in `dequeueSystem.ts` exactly. */
export type ResolvedWorkerVersion = {
  worker: BackgroundWorker;
  tasks: BackgroundWorkerTask[];
  queues: TaskQueue[];
  deployment: WorkerDeployment | null;
};

// The canonical authenticated-environment shape (slug/type/project/organization/orgMember/…).
// Re-aliased from the engine type so the cache slot cannot drift from `toAuthenticated()`'s output.
export type ResolvedAuthenticatedEnv = AuthenticatedEnvironment;

/**
 * The slim `lockedBy` (BackgroundWorkerTask) + `lockedToVersion` (BackgroundWorker, with its
 * WorkerDeployment) shape — the UNION of every field webapp run sites read off these two
 * cross-DB worker relations. Each field is optional because a run may be locked to a version
 * but not a task (or neither); resolvers return only what exists.
 */
export type ResolvedRunLockedWorker = {
  lockedBy: {
    id: string;
    filePath: string;
    exportName: string | null;
    slug: string;
    machineConfig: Prisma.JsonValue | null;
    worker: {
      id: string;
      version: string;
      sdkVersion: string;
      cliVersion: string;
      supportsLazyAttempts: boolean;
      deployment: {
        friendlyId: string;
        shortCode: string;
        version: string;
        runtime: string | null;
        runtimeVersion: string | null;
        git: Prisma.JsonValue | null;
      } | null;
    };
  } | null;
  lockedToVersion: {
    version: string;
    sdkVersion: string;
    runtime: string | null;
    runtimeVersion: string | null;
    supportsLazyAttempts: boolean;
  } | null;
};

type Stamped<V> = { value: V; epoch: number };

export class ControlPlaneCache {
  readonly #env: BoundedTtlCache<Stamped<ResolvedEnv | null>>;
  readonly #version: BoundedTtlCache<Stamped<ResolvedWorkerVersion | null>>;
  readonly #envExists: BoundedTtlCache<Stamped<boolean>>;
  readonly #authEnv: BoundedTtlCache<Stamped<ResolvedAuthenticatedEnv | null>>;
  readonly #lockedWorker: BoundedTtlCache<Stamped<ResolvedRunLockedWorker | null>>;

  // Explicit invalidation: bumping a key's epoch forces the next read to miss.
  readonly #epochs = new Map<string, number>();

  constructor(opts?: { ttlMs?: number; maxEntries?: number }) {
    const ttl = opts?.ttlMs ?? DEFAULT_CP_CACHE_TTL_MS;
    const max = opts?.maxEntries ?? DEFAULT_CP_CACHE_MAX_ENTRIES;
    this.#env = new BoundedTtlCache(ttl, max);
    this.#version = new BoundedTtlCache(ttl, max);
    this.#envExists = new BoundedTtlCache(ttl, max);
    this.#authEnv = new BoundedTtlCache(ttl, max);
    this.#lockedWorker = new BoundedTtlCache(ttl, max);
  }

  #epoch(key: string): number {
    return this.#epochs.get(key) ?? 0;
  }

  #read<V>(cache: BoundedTtlCache<Stamped<V>>, key: string): V | undefined {
    const entry = cache.get(key);
    if (entry === undefined || entry.epoch !== this.#epoch(key)) {
      return undefined;
    }
    return entry.value;
  }

  #write<V>(cache: BoundedTtlCache<Stamped<V>>, key: string, value: V): void {
    cache.set(key, { value, epoch: this.#epoch(key) });
  }

  #bump(key: string): void {
    this.#epochs.set(key, this.#epoch(key) + 1);
  }

  getEnv(id: string): (ResolvedEnv | null) | undefined {
    return this.#read(this.#env, `env:${id}`);
  }
  setEnv(id: string, value: ResolvedEnv | null): void {
    this.#write(this.#env, `env:${id}`, value);
  }
  invalidateEnv(id: string): void {
    this.#bump(`env:${id}`);
  }

  // worker version: key = `${environmentId}:${backgroundWorkerId ?? "current"}`
  getWorkerVersion(key: string): (ResolvedWorkerVersion | null) | undefined {
    return this.#read(this.#version, `version:${key}`);
  }
  setWorkerVersion(key: string, value: ResolvedWorkerVersion | null): void {
    this.#write(this.#version, `version:${key}`, value);
  }

  // env existence (boolean; for the dropped-FK replacement check)
  getEnvExists(id: string): boolean | undefined {
    return this.#read(this.#envExists, `envExists:${id}`);
  }
  setEnvExists(id: string, exists: boolean): void {
    this.#write(this.#envExists, `envExists:${id}`, exists);
  }

  // full authenticated environment (toAuthenticated shape)
  getAuthEnv(id: string): (ResolvedAuthenticatedEnv | null) | undefined {
    return this.#read(this.#authEnv, `authEnv:${id}`);
  }
  setAuthEnv(id: string, value: ResolvedAuthenticatedEnv | null): void {
    this.#write(this.#authEnv, `authEnv:${id}`, value);
  }

  // run-locked worker (lockedBy + lockedToVersion); key = `${lockedById ?? "_"}:${lockedToVersionId ?? "_"}`
  getLockedWorker(key: string): (ResolvedRunLockedWorker | null) | undefined {
    return this.#read(this.#lockedWorker, `lockedWorker:${key}`);
  }
  setLockedWorker(key: string, value: ResolvedRunLockedWorker | null): void {
    this.#write(this.#lockedWorker, `lockedWorker:${key}`, value);
  }
}
