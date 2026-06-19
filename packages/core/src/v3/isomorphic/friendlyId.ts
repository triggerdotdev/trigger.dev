import { customAlphabet } from "nanoid";
import cuid from "@bugsnag/cuid";

const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

export function generateFriendlyId(prefix: string, size?: number) {
  return `${prefix}_${idGenerator(size)}`;
}

export function generateInternalId() {
  return cuid();
}

// KSUID epoch (2014-05-13T16:53:20Z) — seconds offset applied to the unix timestamp.
const KSUID_EPOCH = 1_400_000_000;
const KSUID_TIMESTAMP_BYTES = 4;
const KSUID_PAYLOAD_BYTES = 16;
const KSUID_TOTAL_BYTES = KSUID_TIMESTAMP_BYTES + KSUID_PAYLOAD_BYTES;
const KSUID_STRING_LENGTH = 27;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Encode raw bytes as base62, left-padded to the given length. */
function base62Encode(bytes: Uint8Array, length: number): string {
  // Big-endian base-256 -> base-62 conversion (repeated division).
  const digits = Array.from(bytes);
  let result = "";

  while (digits.length > 0) {
    let remainder = 0;
    const quotient: number[] = [];

    for (let i = 0; i < digits.length; i++) {
      const acc = (digits[i] ?? 0) + remainder * 256;
      const q = Math.floor(acc / 62);
      remainder = acc % 62;

      if (quotient.length > 0 || q > 0) {
        quotient.push(q);
      }
    }

    // `remainder` is always in [0, 61], so this index is always valid.
    result = BASE62_ALPHABET.charAt(remainder) + result;
    digits.length = 0;
    digits.push(...quotient);
  }

  return result.padStart(length, BASE62_ALPHABET.charAt(0));
}

/**
 * Mint a KSUID body: a 27-char, base62, time-ordered identifier.
 *
 * Layout: 4-byte big-endian uint32 timestamp (seconds since the KSUID epoch)
 * + 16 random bytes = 20 bytes, base62-encoded and left-padded to 27 chars.
 *
 * Isomorphic: relies only on `globalThis.crypto.getRandomValues` for randomness.
 */
export function generateKsuid(): string {
  const bytes = new Uint8Array(KSUID_TOTAL_BYTES);

  const timestamp = Math.floor(Date.now() / 1000) - KSUID_EPOCH;
  bytes[0] = (timestamp >>> 24) & 0xff;
  bytes[1] = (timestamp >>> 16) & 0xff;
  bytes[2] = (timestamp >>> 8) & 0xff;
  bytes[3] = timestamp & 0xff;

  globalThis.crypto.getRandomValues(bytes.subarray(KSUID_TIMESTAMP_BYTES));

  return base62Encode(bytes, KSUID_STRING_LENGTH);
}

/**
 * Pure string discriminator: is this id (or friendlyId) a KSUID-format body?
 *
 * Strips a leading `"<prefix>_"` if present, then tests the body for the KSUID
 * shape (27 chars, base62). The 25-char legacy cuid and any malformed input
 * return false. Never throws.
 */
export function isKsuidId(idOrFriendlyId: string): boolean {
  if (!idOrFriendlyId) {
    return false;
  }

  const underscoreIndex = idOrFriendlyId.indexOf("_");
  const body =
    underscoreIndex === -1 ? idOrFriendlyId : idOrFriendlyId.slice(underscoreIndex + 1);

  return body.length === KSUID_STRING_LENGTH && /^[0-9A-Za-z]{27}$/.test(body);
}

/** Convert an internal ID to a friendly ID */
export function toFriendlyId(entityName: string, internalId: string): string {
  if (!entityName) {
    throw new Error("Entity name cannot be empty");
  }

  if (!internalId) {
    throw new Error("Internal ID cannot be empty");
  }

  if (internalId.startsWith(`${entityName}_`)) {
    return internalId;
  }

  return `${entityName}_${internalId}`;
}

/** Convert a friendly ID to an internal ID */
export function fromFriendlyId(friendlyId: string, expectedEntityName?: string): string {
  if (!friendlyId) {
    throw new Error("Friendly ID cannot be empty");
  }

  const parts = friendlyId.split("_");

  if (parts.length !== 2) {
    throw new Error("Invalid friendly ID format");
  }

  const [entityName, internalId] = parts;

  if (!entityName) {
    throw new Error("Entity name cannot be empty");
  }

  if (!internalId) {
    throw new Error("Internal ID cannot be empty");
  }

  if (expectedEntityName && entityName !== expectedEntityName) {
    throw new Error(`Invalid entity name: ${entityName}`);
  }

  return internalId;
}

export class IdUtil {
  constructor(private entityName: string) {}

  generate() {
    const internalId = generateInternalId();

    return {
      id: internalId,
      friendlyId: this.toFriendlyId(internalId),
    };
  }

  /** Mint an id whose body is a KSUID (27-char, base62, time-ordered). */
  generateKsuid() {
    const internalId = generateKsuid();

    return {
      id: internalId,
      friendlyId: this.toFriendlyId(internalId),
    };
  }

  toFriendlyId(internalId: string) {
    return toFriendlyId(this.entityName, internalId);
  }

  fromFriendlyId(friendlyId: string) {
    return fromFriendlyId(friendlyId);
  }

  /** Will convert friendlyIds, and will leave ids as they are */
  toId(value: string) {
    if (value.startsWith(`${this.entityName}_`)) {
      return fromFriendlyId(value);
    }

    return value;
  }
}

export const BackgroundWorkerId = new IdUtil("worker");
export const CheckpointId = new IdUtil("checkpoint");
export const QueueId = new IdUtil("queue");
export const RunId = new IdUtil("run");
export const SnapshotId = new IdUtil("snapshot");
export const WaitpointId = new IdUtil("waitpoint");
export const BatchId = new IdUtil("batch");
export const BulkActionId = new IdUtil("bulk");
export const AttemptId = new IdUtil("attempt");
export const ErrorId = new IdUtil("error");
export const SessionId = new IdUtil("session");

export class IdGenerator {
  private alphabet: string;
  private length: number;
  private prefix: string;

  constructor({ alphabet, length, prefix }: { alphabet: string; length: number; prefix: string }) {
    this.alphabet = alphabet;
    this.length = length;
    this.prefix = prefix;
  }

  generate(): string {
    return `${this.prefix}${customAlphabet(this.alphabet, this.length)()}`;
  }
}
