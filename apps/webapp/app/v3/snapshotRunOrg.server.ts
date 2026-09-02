import { LRUCache } from "lru-cache";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

/**
 * How long an authoritative run→org read will wait before giving up. Shares the shape of the
 * org-mode source's warm timeout, but here the deadline REJECTS: this feeds the redis-only fallback
 * gate, which must fail closed rather than answer with a wrong org.
 */
const AUTHORITATIVE_TIMEOUT_MS = 500;

const DEFAULT_CACHE_MAX = 50_000;

/**
 * What resolution needs from Prisma, narrowed so a test injects a hand-written fake rather than
 * mocking the client. A run's organisation is reached through its environment: TaskRun.organizationId
 * is nullable on historical rows, while RuntimeEnvironment.organizationId is not.
 */
type RunOrgClient = {
  taskRun: {
    findFirst(args: {
      where: { id: string };
      select: { runtimeEnvironment: { select: { organizationId: true } } };
    }): Promise<{ runtimeEnvironment: { organizationId: string } } | null>;
  };
};

export type SnapshotRunOrgSource = {
  /**
   * A PURE cache get: the cached org id, or undefined on a miss. Never queries, never blocks, never
   * throws. The hot read path calls this, so it does no work — a resident run's mapping is put here
   * for free by `prime`, from a mirrored write or a Redis read hit, and a non-resident run never
   * needs one. There is deliberately no off-path populate: during pure dual-write the read path must
   * issue zero run→org DB reads fleet-wide.
   */
  resolve(runId: string): string | undefined;
  /**
   * Records a run→org mapping the caller learned for free — from a mirrored write or a Redis read
   * hit — so a later `resolve` is a pure hit with no DB read. In-memory, immutable (run→org never
   * changes), no TTL, no invalidation. Fire-and-forget: never queries, never throws.
   */
  prime(runId: string, organizationId: string): void;
  /**
   * Awaits a bounded primary read, caches, and returns the org id. Throws on timeout, client
   * failure, or a run with no organisation, so a caller can fail closed. This is the redis-only
   * fallback gate's last leg, reached only when the sync cache is cold AND some org is redis-only.
   */
  resolveAuthoritative(runId: string): Promise<string>;
};

export function createSnapshotRunOrgSource(clients?: {
  primary: RunOrgClient;
}): SnapshotRunOrgSource {
  const primaryClient = (clients?.primary ?? prisma) as RunOrgClient;
  // No ttl: run→org is immutable, so a cached mapping never goes stale.
  const cache = new LRUCache<string, string>({
    max: env.RUN_ENGINE_SNAPSHOT_STORE_RUN_ORG_CACHE_MAX ?? DEFAULT_CACHE_MAX,
  });

  async function read(runId: string): Promise<string> {
    return primaryClient.taskRun
      .findFirst({
        where: { id: runId },
        select: { runtimeEnvironment: { select: { organizationId: true } } },
      })
      .then((row) => {
        const organizationId = row?.runtimeEnvironment?.organizationId;
        if (!organizationId) {
          throw new Error(`snapshotRunOrg: no organization for run ${runId}`);
        }
        cache.set(runId, organizationId);
        return organizationId;
      });
  }

  return {
    resolve(runId) {
      return cache.get(runId);
    },
    prime(runId, organizationId) {
      // run→org is immutable, so this can only ever confirm what is already there; setting keeps the
      // active run hot in the LRU, which is exactly the run whose mapping the read path will want.
      cache.set(runId, organizationId);
    },
    async resolveAuthoritative(runId) {
      const cached = cache.get(runId);
      if (cached !== undefined) {
        return cached;
      }

      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`snapshotRunOrg: run→org read exceeded ${AUTHORITATIVE_TIMEOUT_MS}ms`)
            ),
          AUTHORITATIVE_TIMEOUT_MS
        );
      });

      try {
        return await Promise.race([read(runId), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

/** Built on first use, never at import: importing this module must have no side effect. */
export function snapshotRunOrgSource(): SnapshotRunOrgSource {
  return singleton("snapshotRunOrgSource", () => createSnapshotRunOrgSource());
}
