import { randomUUID } from "node:crypto";
import { z } from "zod";
import { env } from "~/env.server";
import { createRedisClient, type RedisClient } from "~/redis.server";
import { singleton } from "~/utils/singleton";

const HANDLE_TTL_SECONDS = 24 * 60 * 60;
// Twice the longest send, so a live send never loses its marker.
const TURN_TTL_SECONDS = 100;

const releaseTurnScript = `
if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end
return 0
`;

const McpChatHandle = z.object({
  organizationId: z.string(),
  projectId: z.string(),
  environmentId: z.string(),
  environmentType: z.enum(["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"]),
  sessionId: z.string(),
  agentId: z.string(),
  runId: z.string().optional(),
  lastEventId: z.string().optional(),
  clientData: z.record(z.string(), z.unknown()).optional(),
  turnInFlight: z.boolean(),
});

export type McpChatHandle = z.infer<typeof McpChatHandle>;

export type McpChatHandleStore = {
  get: (userId: string, client: string, chatId: string) => Promise<McpChatHandle | null>;
  put: (userId: string, client: string, chatId: string, handle: McpChatHandle) => Promise<void>;
  delete: (userId: string, client: string, chatId: string) => Promise<void>;
  /** Marks a send in progress; returns its token, or null when another send holds the marker. */
  claimTurn: (userId: string, client: string, chatId: string) => Promise<string | null>;
  /** Clears the marker only if it still holds `token`. */
  releaseTurn: (userId: string, client: string, chatId: string, token: string) => Promise<void>;
};

export function mcpChatHandleKey(userId: string, client: string, chatId: string) {
  return `mcp:chat:${userId}:${client}:${chatId}`;
}

export function mcpChatTurnKey(userId: string, client: string, chatId: string) {
  return `${mcpChatHandleKey(userId, client, chatId)}:turn`;
}

export function createMcpChatHandleStore(
  redis: Pick<RedisClient, "getex" | "set" | "del" | "eval">,
  ttlSeconds = HANDLE_TTL_SECONDS
): McpChatHandleStore {
  return {
    get: async (userId, client, chatId) => {
      const raw = await redis.getex(mcpChatHandleKey(userId, client, chatId), "EX", ttlSeconds);
      if (!raw) return null;
      const parsed = McpChatHandle.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    },
    put: async (userId, client, chatId, handle) => {
      await redis.set(
        mcpChatHandleKey(userId, client, chatId),
        JSON.stringify(handle),
        "EX",
        ttlSeconds
      );
    },
    delete: async (userId, client, chatId) => {
      await redis.del(mcpChatHandleKey(userId, client, chatId));
    },
    claimTurn: async (userId, client, chatId) => {
      const token = randomUUID();
      const set = await redis.set(
        mcpChatTurnKey(userId, client, chatId),
        token,
        "EX",
        TURN_TTL_SECONDS,
        "NX"
      );
      return set === "OK" ? token : null;
    },
    releaseTurn: async (userId, client, chatId, token) => {
      await redis.eval(releaseTurnScript, 1, mcpChatTurnKey(userId, client, chatId), token);
    },
  };
}

export function mcpChatHandleStore(): McpChatHandleStore {
  return singleton("mcpChatHandleStore", () =>
    createMcpChatHandleStore(
      createRedisClient("trigger:mcp-chat-handles", {
        host: env.CACHE_REDIS_HOST,
        port: env.CACHE_REDIS_PORT,
        username: env.CACHE_REDIS_USERNAME,
        password: env.CACHE_REDIS_PASSWORD,
        tlsDisabled: env.CACHE_REDIS_TLS_DISABLED === "true",
        clusterMode: env.CACHE_REDIS_CLUSTER_MODE_ENABLED === "1",
      })
    )
  );
}
