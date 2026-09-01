import { LRUCache } from "lru-cache";
import { $replica, prisma } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
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
   * Cache hit or undefined. On a miss, kicks off a replica populate off-path and returns at once.
   * Never blocks, never throws.
   */
  resolve(runId: string): string | undefined;
  /**
   * Awaits a bounded primary read, caches, and returns the org id. Throws on timeout, client
   * failure, or a run with no organisation, so a caller can fail closed.
   */
  resolveAuthoritative(runId: string): Promise<string>;
};

export function createSnapshotRunOrgSource(clients?: {
  primary: RunOrgClient;
  replica: RunOrgClient;
}): SnapshotRunOrgSource {
  const primaryClient = (clients?.primary ?? prisma) as RunOrgClient;
  const replicaClient = (clients?.replica ?? $replica) as RunOrgClient;
  // No ttl: run→org is immutable, so a cached mapping never goes stale.
  const cache = new LRUCache<string, string>({
    max: env.RUN_ENGINE_SNAPSHOT_STORE_RUN_ORG_CACHE_MAX ?? DEFAULT_CACHE_MAX,
  });
  const inFlight = new Set<string>();

  async function read(runId: string, client: RunOrgClient): Promise<string> {
    return client.taskRun
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
      const cached = cache.get(runId);
      if (cached !== undefined) {
        return cached;
      }
      if (!inFlight.has(runId)) {
        inFlight.add(runId);
        void read(runId, replicaClient)
          .catch((error) => {
            logger.warn("snapshotRunOrg: run→org populate failed", { runId, error });
          })
          .finally(() => {
            inFlight.delete(runId);
          });
      }
      return undefined;
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
        return await Promise.race([read(runId, primaryClient), deadline]);
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
