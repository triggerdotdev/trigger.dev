import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import Redis from "ioredis";
import { env } from "~/env.server";
import { requireAdminApiRequest } from "~/services/personalAccessToken.server";
import { getRunsReplicationConfiguredSources } from "~/services/runsReplicationGlobal.server";

/**
 * Probes per-source replication leadership via the redlock leader-lock key, which
 * is DOUBLE-PREFIXED with `logical-replication-client:` — once from the connection's
 * keyPrefix and once from redlock's resource string. The lock is keyed on the
 * replication slot, so we prefix this connection with
 * `runs-replication:logical-replication-client:` and EXISTS on the resource
 * `logical-replication-client:<slotName>`, resolving to:
 *   runs-replication:logical-replication-client:logical-replication-client:<slotName>
 */
async function probeLeadership(
  sources: { id: string; slotName: string }[]
): Promise<Map<string, boolean>> {
  const leaders = new Map<string, boolean>();

  const redis = new Redis({
    keyPrefix: "runs-replication:logical-replication-client:",
    port: env.RUN_REPLICATION_REDIS_PORT ?? undefined,
    host: env.RUN_REPLICATION_REDIS_HOST ?? undefined,
    username: env.RUN_REPLICATION_REDIS_USERNAME ?? undefined,
    password: env.RUN_REPLICATION_REDIS_PASSWORD ?? undefined,
    enableAutoPipelining: true,
    ...(env.RUN_REPLICATION_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });

  try {
    for (const source of sources) {
      const exists = await redis.exists(`logical-replication-client:${source.slotName}`);
      leaders.set(source.id, exists === 1);
    }
  } finally {
    await redis.quit();
  }

  return leaders;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireAdminApiRequest(request);

  const sources = getRunsReplicationConfiguredSources();

  if (!sources || sources.length === 0) {
    return json({ enabled: false, sources: [] });
  }

  const leaders = await probeLeadership(sources);

  return json({
    enabled: env.RUN_REPLICATION_ENABLED === "1" && sources.length > 0,
    sources: sources.map((s) => ({
      id: s.id,
      slotName: s.slotName,
      originGeneration: s.originGeneration,
      leader: leaders.get(s.id) ?? false,
    })),
  });
}
