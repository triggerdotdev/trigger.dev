import { $replica, type PrismaClientOrTransaction } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";

/** Cache key for events without an organization, e.g. personal access tokens. Never an org id. */
const NO_ORGANIZATION = "";

/**
 * Whether an org's audit events are recorded: the org's `auditLogsRecording` override, then the
 * global flag, then off. An event without an org follows the global flag alone. Cached per org, so
 * recording an event doesn't read the database each time. The lookup is cached as soon as it starts,
 * so events that arrive while it runs share it. Never throws: a lookup that fails, or takes longer
 * than `lookupTimeoutMs`, is logged and records nothing until the cached answer expires.
 */
export function createAuditRecordingFlag(options: {
  prisma: PrismaClientOrTransaction;
  cacheTtlMs: number;
  cacheMaxEntries: number;
  lookupTimeoutMs: number;
}): (organizationId: string | null) => Promise<boolean> {
  const flag = makeFlag(options.prisma);
  const cache = new BoundedTtlCache<Promise<boolean>>(options.cacheTtlMs, options.cacheMaxEntries);

  async function resolve(organizationId: string | null): Promise<boolean> {
    const overrides = organizationId
      ? (
          await options.prisma.organization.findFirst({
            where: { id: organizationId },
            select: { featureFlags: true },
          })
        )?.featureFlags
      : undefined;

    return flag({
      key: FEATURE_FLAG.auditLogsRecording,
      defaultValue: false,
      overrides: (overrides as Record<string, unknown> | null | undefined) ?? {},
    });
  }

  async function lookUp(organizationId: string | null): Promise<boolean> {
    // A hung database would otherwise hold every event for the org in memory until it answers.
    // The query keeps running; only the events stop waiting for it.
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`timed out after ${options.lookupTimeoutMs} ms`)),
        options.lookupTimeoutMs
      );
    });
    try {
      return await Promise.race([resolve(organizationId), timedOut]);
    } catch (error) {
      // Events are dropped until the next lookup. The failure is cached like any answer, as the
      // realtime backend flag does, so an outage costs one read and one line per org per TTL.
      logger.error("Audit logs: failed to resolve the recording flag, not recording", {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  return (organizationId) => {
    const key = organizationId ?? NO_ORGANIZATION;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const enabled = lookUp(organizationId);
    cache.set(key, enabled);
    return enabled;
  };
}

/** The process-wide gate. Its cache lives in the `auditRecordingFlag` singleton. */
export function isAuditRecordingEnabledFor(organizationId: string | null): Promise<boolean> {
  return singleton("auditRecordingFlag", () =>
    createAuditRecordingFlag({
      prisma: $replica,
      cacheTtlMs: env.AUDIT_LOGS_RECORDING_FLAG_CACHE_TTL_MS,
      cacheMaxEntries: env.AUDIT_LOGS_RECORDING_FLAG_CACHE_MAX_ENTRIES,
      lookupTimeoutMs: env.AUDIT_LOGS_RECORDING_FLAG_LOOKUP_TIMEOUT_MS,
    })
  )(organizationId);
}
