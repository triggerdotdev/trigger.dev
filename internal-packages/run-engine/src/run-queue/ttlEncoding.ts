/**
 * TTL sorted set member encoding/decoding.
 *
 * TTL sorted set stores runs with their expiration time as the score.
 * The member contains enough info to ack the normal queue when the run expires.
 */

// ASCII Record Separator - safe delimiter that won't appear in IDs
const DELIMITER = "\x1e";

export interface TtlMember {
  runId: string;
  queueKey: string;
  orgId: string;
}

/**
 * Encode TTL member for storage in sorted set.
 * Format: runId␞queueKey␞orgId
 */
export function encodeTtlMember(data: TtlMember): string {
  return [data.runId, data.queueKey, data.orgId].join(DELIMITER);
}

/**
 * Decode TTL member from sorted set.
 */
export function decodeTtlMember(member: string): TtlMember | undefined {
  const parts = member.split(DELIMITER);
  if (parts.length !== 3) {
    return undefined;
  }

  const [runId, queueKey, orgId] = parts;
  return { runId, queueKey, orgId };
}

/**
 * Check if a string is an encoded TTL member.
 */
export function isEncodedTtlMember(member: string): boolean {
  return member.includes(DELIMITER);
}

/**
 * Extract runId from TTL member (first part).
 */
export function getRunIdFromTtlMember(member: string): string {
  const delimPos = member.indexOf(DELIMITER);
  if (delimPos > 0) {
    return member.substring(0, delimPos);
  }
  return member;
}

/**
 * Lua helpers for TTL member encoding/decoding.
 * Include in Lua scripts that need to work with TTL members.
 */
export const LUA_TTL_ENCODING_HELPERS = `
-- TTL Member Encoding Helpers
local TTL_DELIMITER = "\\x1e"

local function encodeTtlMember(runId, queueKey, orgId)
  return runId .. TTL_DELIMITER .. queueKey .. TTL_DELIMITER .. orgId
end

local function decodeTtlMember(member)
  local parts = {}
  for part in string.gmatch(member, "([^" .. TTL_DELIMITER .. "]+)") do
    table.insert(parts, part)
  end
  if #parts ~= 3 then
    return nil, nil, nil
  end
  return parts[1], parts[2], parts[3]  -- runId, queueKey, orgId
end

local function getRunIdFromTtlMember(member)
  local delimPos = string.find(member, TTL_DELIMITER, 1, true)
  if delimPos then
    return string.sub(member, 1, delimPos - 1)
  end
  return member
end
`;
