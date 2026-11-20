import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { RedisClient } from "~/redis.server";

const TTL_SECONDS = 10 * 60;
const DENIED_TTL_MS = 60 * 1000;
const ID_PATTERN = /^mcpc_[A-Za-z0-9_-]{32}$/;

const RecordSchema = z.object({
  id: z.string(),
  userId: z.string(),
  tokenId: z.string(),
  client: z.string(),
  clientId: z.string().optional(),
  tool: z.string(),
  subject: z
    .object({
      organizationId: z.string(),
      projectId: z.string().optional(),
      environmentId: z.string().optional(),
    })
    .nullable(),
  argsDigest: z.string(),
  preview: z.string(),
  truncated: z.boolean().optional(),
  expiresAt: z.number(),
  approvedAt: z.number().optional(),
  consumedAt: z.number().optional(),
  deniedAt: z.number().optional(),
});

export type McpConfirmationRecord = z.infer<typeof RecordSchema>;

type McpPendingConfirmation = Omit<
  McpConfirmationRecord,
  "id" | "expiresAt" | "approvedAt" | "consumedAt" | "deniedAt"
>;

export type McpApprovalLookup = Pick<
  McpConfirmationRecord,
  "userId" | "tokenId" | "client" | "tool" | "argsDigest"
>;

export type McpConfirmationStore = {
  createPending: (
    record: McpPendingConfirmation
  ) => Promise<{ id: string; url: string } | { denied: true; id: string }>;
  get: (id: string, userId: string) => Promise<McpConfirmationRecord | null>;
  approve: (id: string, userId: string) => Promise<boolean>;
  deny: (id: string, userId: string) => Promise<boolean>;
  consumeApproved: (lookup: McpApprovalLookup) => Promise<{ id: string; preview: string } | null>;
};

const approveScript = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local r = cjson.decode(raw)
if r.userId ~= ARGV[1] or r.truncated or r.expiresAt <= tonumber(ARGV[2]) then return 0 end
if r.deniedAt then return 0 end
if r.approvedAt or r.consumedAt then return 1 end
local ttl = redis.call("PTTL", KEYS[1])
if ttl <= 0 then return 0 end
r.approvedAt = tonumber(ARGV[2])
redis.call("SET", KEYS[1], cjson.encode(r), "PX", ttl)
redis.call("SET", KEYS[2], r.id, "PX", ttl)
return 1
`;

const denyScript = `
local raw = redis.call("GET", KEYS[1])
if not raw then return 0 end
local r = cjson.decode(raw)
if r.userId ~= ARGV[1] or r.expiresAt <= tonumber(ARGV[2]) then return 0 end
if r.approvedAt or r.consumedAt or r.deniedAt then return 0 end
r.deniedAt = tonumber(ARGV[2])
r.expiresAt = tonumber(ARGV[2]) + tonumber(ARGV[3])
redis.call("SET", KEYS[1], cjson.encode(r), "PX", tonumber(ARGV[3]))
if redis.call("GET", KEYS[2]) == r.id then
  redis.call("SET", KEYS[2], r.id, "PX", tonumber(ARGV[3]))
end
return 1
`;

const consumeScript = `
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return nil end
local raw = redis.call("GET", KEYS[2])
if not raw then return nil end
local r = cjson.decode(raw)
if r.userId ~= ARGV[2] or r.tokenId ~= ARGV[3] or r.client ~= ARGV[4] or r.tool ~= ARGV[5]
  or r.argsDigest ~= ARGV[6] then
  return nil
end
if not r.approvedAt or r.consumedAt or r.deniedAt or r.expiresAt <= tonumber(ARGV[7]) then return nil end
local ttl = redis.call("PTTL", KEYS[2])
if ttl <= 0 then return nil end
r.consumedAt = tonumber(ARGV[7])
redis.call("SET", KEYS[2], cjson.encode(r), "PX", ttl)
redis.call("DEL", KEYS[1])
return { r.id, r.preview }
`;

const recordKey = (userId: string, id: string) => `mcp:confirm:{${userId}}:record:${id}`;

const lookupKey =
  (kind: "approved" | "pending") =>
  ({ userId, tokenId, client, tool, argsDigest }: McpApprovalLookup) =>
    `mcp:confirm:{${userId}}:${kind}:${createHash("sha256")
      .update(JSON.stringify([tokenId, client, tool, argsDigest]))
      .digest("hex")}`;

const approvalKey = lookupKey("approved");
const pendingKey = lookupKey("pending");

function parseRecord(raw: string | null): McpConfirmationRecord | null {
  if (!raw) return null;
  try {
    return RecordSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}

export function createMcpConfirmationStore(
  redis: Pick<RedisClient, "set" | "get" | "eval">,
  options: { origin: string; now?: () => number }
): McpConfirmationStore {
  const now = options.now ?? Date.now;
  const confirmationUrl = (id: string) => `${options.origin}/mcp/confirm/${id}`;

  const get = async (id: string, userId: string) => {
    if (!ID_PATTERN.test(id)) return null;
    const record = parseRecord(await redis.get(recordKey(userId, id)));
    if (!record || record.userId !== userId || record.expiresAt <= now()) return null;
    return record;
  };

  return {
    async createPending(pending) {
      const existing = await get((await redis.get(pendingKey(pending))) ?? "", pending.userId);
      if (existing?.deniedAt) return { denied: true, id: existing.id };
      if (existing && !existing.approvedAt && !existing.consumedAt && !existing.deniedAt) {
        return { id: existing.id, url: confirmationUrl(existing.id) };
      }

      const id = `mcpc_${randomBytes(24).toString("base64url")}`;
      const record: McpConfirmationRecord = {
        ...pending,
        id,
        expiresAt: now() + TTL_SECONDS * 1000,
      };
      const created = await redis.set(
        recordKey(pending.userId, id),
        JSON.stringify(record),
        "EX",
        TTL_SECONDS,
        "NX"
      );
      if (created !== "OK") throw new Error("Failed to create an MCP confirmation");
      await redis.set(pendingKey(pending), id, "EX", TTL_SECONDS);
      return { id, url: confirmationUrl(id) };
    },

    get,

    async approve(id, userId) {
      const record = await get(id, userId);
      if (!record || record.truncated) return false;
      const result = await redis.eval(
        approveScript,
        2,
        recordKey(userId, id),
        approvalKey(record),
        userId,
        String(now())
      );
      return result === 1;
    },

    async deny(id, userId) {
      const record = await get(id, userId);
      if (!record) return false;
      const result = await redis.eval(
        denyScript,
        2,
        recordKey(userId, id),
        pendingKey(record),
        userId,
        String(now()),
        String(DENIED_TTL_MS)
      );
      return result === 1;
    },

    async consumeApproved(lookup) {
      const key = approvalKey(lookup);
      const id = await redis.get(key);
      if (!id || !ID_PATTERN.test(id)) return null;
      const consumed = await redis.eval(
        consumeScript,
        2,
        key,
        recordKey(lookup.userId, id),
        id,
        lookup.userId,
        lookup.tokenId,
        lookup.client,
        lookup.tool,
        lookup.argsDigest,
        String(now())
      );
      return Array.isArray(consumed)
        ? { id: consumed[0] as string, preview: consumed[1] as string }
        : null;
    },
  };
}
