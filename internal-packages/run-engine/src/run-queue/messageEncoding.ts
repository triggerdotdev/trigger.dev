import { RuntimeEnvironmentType } from "@trigger.dev/database";
import type { OutputPayload, OutputPayloadV2, QueueDescriptor } from "./types.js";

/**
 * Message encoding for optimized Redis storage.
 *
 * This module provides encoding/decoding for the "v3" message format that eliminates
 * the need for separate message keys in Redis, reducing storage by ~80% for pending messages.
 *
 * ## Migration Strategy
 * - New messages are written in v3 format (no message key created)
 * - Old messages (v1/v2) continue to work via message key lookup
 * - Detection is automatic based on format
 * - Old messages drain naturally as they're processed
 * - No backfill required
 *
 * ## Format Detection
 * - Sorted set member with DELIMITER = v3 format
 * - Sorted set member without DELIMITER = legacy format (needs message key lookup)
 * - Worker queue entry starting with "{org:" = legacy format
 * - Worker queue entry with DELIMITER = v3 format
 */

// ASCII Record Separator - won't appear in IDs, queue names, or other fields
const DELIMITER = "\x1e";

// Environment type single-char encoding for compact storage
const ENV_TYPE_TO_CHAR: Record<RuntimeEnvironmentType, string> = {
  DEVELOPMENT: "D",
  STAGING: "S",
  PREVIEW: "V",
  PRODUCTION: "P",
};

const CHAR_TO_ENV_TYPE: Record<string, RuntimeEnvironmentType> = {
  D: "DEVELOPMENT",
  S: "STAGING",
  V: "PREVIEW",
  P: "PRODUCTION",
};

/**
 * Data encoded in V3 message key value.
 * Uses compact pipe-delimited format instead of JSON.
 * Fields that can be derived from the queue key are excluded.
 */
export interface EncodedMessageKeyData {
  /** Full queue key - needed for queue operations */
  queue: string;
  /** Unix timestamp for scoring */
  timestamp: number;
  /** Attempt number for retry logic */
  attempt: number;
  /** Environment type (single char encoded) */
  environmentType: RuntimeEnvironmentType;
  /** Worker queue name for routing */
  workerQueue: string;
}

/**
 * @deprecated V3 no longer encodes in sorted set member. Use runId directly.
 * Kept for backwards compatibility during migration.
 */
export interface EncodedQueueMember {
  runId: string;
  workerQueue: string;
  attempt: number;
  environmentType: RuntimeEnvironmentType;
}

/**
 * Data encoded in worker queue entry for v3 format.
 * Includes queue key and timestamp to fully reconstruct the message.
 */
export interface EncodedWorkerQueueEntry extends EncodedQueueMember {
  queueKey: string;
  timestamp: number;
}

// V3 message key prefix to distinguish from legacy JSON
const V3_MESSAGE_PREFIX = "v3:";

/**
 * Encode data for V3 message key value.
 * Format: v3:queue␞timestamp␞attempt␞envTypeChar␞workerQueue
 *
 * This is ~60-100 bytes vs ~400-600+ bytes for JSON.
 */
export function encodeMessageKeyValue(data: EncodedMessageKeyData): string {
  const envChar = ENV_TYPE_TO_CHAR[data.environmentType];
  return (
    V3_MESSAGE_PREFIX +
    [data.queue, data.timestamp.toString(), data.attempt.toString(), envChar, data.workerQueue].join(
      DELIMITER
    )
  );
}

/**
 * Decode V3 message key value.
 * Returns undefined if not in V3 format.
 */
export function decodeMessageKeyValue(value: string): EncodedMessageKeyData | undefined {
  if (!value.startsWith(V3_MESSAGE_PREFIX)) {
    return undefined;
  }

  const content = value.slice(V3_MESSAGE_PREFIX.length);
  const parts = content.split(DELIMITER);

  if (parts.length !== 5) {
    return undefined;
  }

  const [queue, timestampStr, attemptStr, envChar, workerQueue] = parts;
  const environmentType = CHAR_TO_ENV_TYPE[envChar];

  if (!environmentType) {
    return undefined;
  }

  return {
    queue,
    timestamp: parseInt(timestampStr, 10),
    attempt: parseInt(attemptStr, 10),
    environmentType,
    workerQueue,
  };
}

/**
 * Check if a message key value is V3 format (starts with v3: prefix).
 */
export function isV3MessageKeyValue(value: string): boolean {
  return value.startsWith(V3_MESSAGE_PREFIX);
}

/**
 * Check if a sorted set member is in v3 encoded format.
 * @deprecated V3 no longer encodes in sorted set. Members are just runIds.
 */
export function isEncodedQueueMember(member: string): boolean {
  return member.includes(DELIMITER);
}

/**
 * Check if a worker queue entry is in v3 encoded format.
 * Legacy format starts with "{org:" (message key path).
 */
export function isEncodedWorkerQueueEntry(entry: string): boolean {
  return !entry.startsWith("{org:") && entry.includes(DELIMITER);
}

/**
 * Encode message data for sorted set member.
 * Format: runId␞workerQueue␞attempt␞envTypeChar
 */
export function encodeQueueMember(data: EncodedQueueMember): string {
  const envChar = ENV_TYPE_TO_CHAR[data.environmentType];
  return [data.runId, data.workerQueue, data.attempt.toString(), envChar].join(DELIMITER);
}

/**
 * Decode sorted set member to message data.
 * Returns undefined if not in v3 format.
 */
export function decodeQueueMember(member: string): EncodedQueueMember | undefined {
  if (!isEncodedQueueMember(member)) {
    return undefined;
  }

  const parts = member.split(DELIMITER);
  if (parts.length !== 4) {
    return undefined;
  }

  const [runId, workerQueue, attemptStr, envChar] = parts;
  const environmentType = CHAR_TO_ENV_TYPE[envChar];

  if (!environmentType) {
    return undefined;
  }

  return {
    runId,
    workerQueue,
    attempt: parseInt(attemptStr, 10),
    environmentType,
  };
}

/**
 * Encode message data for worker queue entry.
 * Format: runId␞workerQueue␞attempt␞envTypeChar␞queueKey␞timestamp
 */
export function encodeWorkerQueueEntry(data: EncodedWorkerQueueEntry): string {
  const envChar = ENV_TYPE_TO_CHAR[data.environmentType];
  return [
    data.runId,
    data.workerQueue,
    data.attempt.toString(),
    envChar,
    data.queueKey,
    data.timestamp.toString(),
  ].join(DELIMITER);
}

/**
 * Decode worker queue entry to message data.
 * Returns undefined if not in v3 format.
 */
export function decodeWorkerQueueEntry(entry: string): EncodedWorkerQueueEntry | undefined {
  if (!isEncodedWorkerQueueEntry(entry)) {
    return undefined;
  }

  const parts = entry.split(DELIMITER);
  if (parts.length !== 6) {
    return undefined;
  }

  const [runId, workerQueue, attemptStr, envChar, queueKey, timestampStr] = parts;
  const environmentType = CHAR_TO_ENV_TYPE[envChar];

  if (!environmentType) {
    return undefined;
  }

  return {
    runId,
    workerQueue,
    attempt: parseInt(attemptStr, 10),
    environmentType,
    queueKey,
    timestamp: parseInt(timestampStr, 10),
  };
}

/**
 * Reconstruct full OutputPayloadV2 from encoded worker queue entry and queue descriptor.
 */
export function reconstructMessageFromWorkerEntry(
  entry: EncodedWorkerQueueEntry,
  descriptor: QueueDescriptor
): OutputPayloadV2 {
  return {
    version: "2",
    runId: entry.runId,
    taskIdentifier: descriptor.queue,
    orgId: descriptor.orgId,
    projectId: descriptor.projectId,
    environmentId: descriptor.envId,
    environmentType: entry.environmentType,
    queue: entry.queueKey,
    concurrencyKey: descriptor.concurrencyKey,
    timestamp: entry.timestamp,
    attempt: entry.attempt,
    workerQueue: entry.workerQueue,
  };
}

/**
 * Extract runId from either v3 encoded member or legacy member.
 * Legacy members are just the runId itself.
 */
export function getRunIdFromMember(member: string): string {
  if (isEncodedQueueMember(member)) {
    const decoded = decodeQueueMember(member);
    return decoded?.runId ?? member;
  }
  return member;
}

/**
 * Lua helper functions to be included in Redis scripts.
 * These handle format detection and parsing within Lua.
 */
export const LUA_ENCODING_HELPERS = `
-- Delimiter for v3 encoded format (ASCII Record Separator)
local DELIMITER = "\\x1e"

-- Check if a string is v3 encoded (contains delimiter)
local function isV3Encoded(str)
  return string.find(str, DELIMITER, 1, true) ~= nil
end

-- Check if worker queue entry is legacy format (starts with {org:)
local function isLegacyWorkerEntry(entry)
  return string.sub(entry, 1, 5) == "{org:"
end

-- Encode queue member: runId, workerQueue, attempt, envTypeChar
local function encodeQueueMember(runId, workerQueue, attempt, envTypeChar)
  return runId .. DELIMITER .. workerQueue .. DELIMITER .. tostring(attempt) .. DELIMITER .. envTypeChar
end

-- Decode queue member, returns: runId, workerQueue, attempt, envTypeChar (or nil if not v3)
local function decodeQueueMember(member)
  if not isV3Encoded(member) then
    return nil
  end
  local parts = {}
  for part in string.gmatch(member, "([^" .. DELIMITER .. "]+)") do
    table.insert(parts, part)
  end
  if #parts ~= 4 then
    return nil
  end
  return parts[1], parts[2], tonumber(parts[3]), parts[4]
end

-- Encode worker queue entry: runId, workerQueue, attempt, envTypeChar, queueKey, timestamp
local function encodeWorkerEntry(runId, workerQueue, attempt, envTypeChar, queueKey, timestamp)
  return runId .. DELIMITER .. workerQueue .. DELIMITER .. tostring(attempt) .. DELIMITER .. envTypeChar .. DELIMITER .. queueKey .. DELIMITER .. tostring(timestamp)
end

-- Decode worker queue entry, returns: runId, workerQueue, attempt, envTypeChar, queueKey, timestamp (or nil if not v3)
local function decodeWorkerEntry(entry)
  if isLegacyWorkerEntry(entry) then
    return nil
  end
  if not isV3Encoded(entry) then
    return nil
  end
  local parts = {}
  for part in string.gmatch(entry, "([^" .. DELIMITER .. "]+)") do
    table.insert(parts, part)
  end
  if #parts ~= 6 then
    return nil
  end
  return parts[1], parts[2], tonumber(parts[3]), parts[4], parts[5], tonumber(parts[6])
end

-- Get runId from member (works for both v3 and legacy)
local function getRunIdFromMember(member)
  if isV3Encoded(member) then
    local runId = decodeQueueMember(member)
    return runId or member
  end
  return member
end

-- Environment type char mappings
local envTypeToChar = {
  DEVELOPMENT = "D",
  STAGING = "S",
  PREVIEW = "V",
  PRODUCTION = "P"
}

local charToEnvType = {
  D = "DEVELOPMENT",
  S = "STAGING",
  V = "PREVIEW",
  P = "PRODUCTION"
}
`;
