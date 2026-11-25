import { createHash } from "node:crypto";
import type { RedisClient } from "~/redis.server";

// Also the bound on the Redis command itself, so a stalled Redis cannot queue calls.
export const SESSION_RESOLVE_TIMEOUT_MS = 500;

export const TELEMETRY_SESSION_REDIS_LIMITS = {
  maxRetriesPerRequest: 1,
  commandTimeout: SESSION_RESOLVE_TIMEOUT_MS,
  // Drop commands while disconnected; queued ones would replay in a burst on recovery.
  enableOfflineQueue: false,
};

// A modern-era session ends after 30 minutes without a tool call.
const TELEMETRY_SESSION_TTL_MS = 30 * 60 * 1000;

const resolveScript = `
local id = redis.call("GET", KEYS[1])
if id then
  redis.call("PEXPIRE", KEYS[1], ARGV[2])
  return { id, 0 }
end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
return { ARGV[1], 1 }
`;

export type TelemetrySessionStore = {
  resolve: (
    userId: string,
    clientKey: string,
    candidateId: string
  ) => Promise<{ id: string; started: boolean }>;
};

const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);

export function telemetryClientKey(client: { clientName?: string; userAgent?: string }) {
  if (client.clientName) return shortHash(`name:${client.clientName}`);
  if (client.userAgent) return shortHash(`ua:${client.userAgent}`);
  return "unknown";
}

export function createTelemetrySessionStore(
  redis: Pick<RedisClient, "eval">,
  ttlMs = TELEMETRY_SESSION_TTL_MS
): TelemetrySessionStore {
  return {
    resolve: async (userId, clientKey, candidateId) => {
      const [id, started] = (await redis.eval(
        resolveScript,
        1,
        `mcp:telemetry-session:${userId}:${clientKey}`,
        candidateId,
        ttlMs
      )) as [string, number];
      return { id, started: started === 1 };
    },
  };
}

// Connects ahead of the first call, since a client without an offline queue drops commands
// until it is ready. Never awaited, and never when the analytics would not be sent.
export function warmTelemetrySessionStore(deps: { enabled: () => boolean; open: () => unknown }) {
  if (!deps.enabled()) return;
  try {
    deps.open();
  } catch {}
}
