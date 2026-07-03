import { customAlphabet } from "nanoid";
import cuid from "@bugsnag/cuid";

const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

export function generateFriendlyId(prefix: string, size?: number) {
  return `${prefix}_${idGenerator(size)}`;
}

// KSUID epoch (2014-05-13T16:53:20Z) — seconds offset applied to the unix timestamp.
const KSUID_EPOCH = 1_400_000_000;
const KSUID_TIMESTAMP_BYTES = 4;
export const KSUID_PAYLOAD_BYTES = 16;
const KSUID_TOTAL_BYTES = KSUID_TIMESTAMP_BYTES + KSUID_PAYLOAD_BYTES;
export const KSUID_STRING_LENGTH = 27;
const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// globalThis.crypto is absent on Node 18.20 (a supported engine) without a flag, so fall back to
// node:crypto's webcrypto, loaded only when the global is missing to stay isomorphic.
type RandomFiller = (array: Uint8Array) => void;

function resolveGetRandomValues(): RandomFiller {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto?.getRandomValues) {
    return (array) => globalCrypto.getRandomValues(array);
  }
  const webcrypto = loadNodeWebCrypto();
  if (webcrypto?.getRandomValues) {
    return (array) => webcrypto.getRandomValues(array);
  }
  throw new Error("No Web Crypto getRandomValues implementation available");
}

function loadNodeWebCrypto(): Crypto | undefined {
  try {
    return (typeof require === "function" ? require("node:crypto") : undefined)?.webcrypto;
  } catch {
    return undefined;
  }
}

// Resolve the crypto source lazily on first use (memoized), so merely importing this
// widely-used module never throws when crypto is unavailable — only minting a KSUID would.
let cachedGetRandomValues: RandomFiller | undefined;
const getRandomValues: RandomFiller = (array) =>
  (cachedGetRandomValues ??= resolveGetRandomValues())(array);

/** Encode raw bytes as base62 (big-endian), left-padded to the given length. */
function base62Encode(bytes: Uint8Array, length: number): string {
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

    result = BASE62_ALPHABET.charAt(remainder) + result;
    digits.length = 0;
    digits.push(...quotient);
  }

  return result.padStart(length, BASE62_ALPHABET.charAt(0));
}

/**
 * 27-char, base62, time-ordered KSUID body (length-disjoint from the 25-char cuid): a 4-byte
 * timestamp (seconds since the KSUID epoch) + a 16-byte payload; ids from different seconds
 * sort in mint order. Payload defaults to CSPRNG entropy; callers may supply up to
 * KSUID_PAYLOAD_BYTES metadata bytes (written first, remainder stays random for uniqueness).
 */
export function generateKsuidId(payload?: Uint8Array): string {
  const bytes = new Uint8Array(KSUID_TOTAL_BYTES);

  const timestamp = Math.floor(Date.now() / 1000) - KSUID_EPOCH;
  bytes[0] = (timestamp >>> 24) & 0xff;
  bytes[1] = (timestamp >>> 16) & 0xff;
  bytes[2] = (timestamp >>> 8) & 0xff;
  bytes[3] = timestamp & 0xff;

  if (payload && payload.length > KSUID_PAYLOAD_BYTES) {
    throw new Error(
      `KSUID payload must be at most ${KSUID_PAYLOAD_BYTES} bytes (got ${payload.length})`
    );
  }
  const reserved = payload?.length ?? 0;
  if (payload && reserved > 0) {
    bytes.set(payload, KSUID_TIMESTAMP_BYTES);
  }
  if (reserved < KSUID_PAYLOAD_BYTES) {
    getRandomValues(bytes.subarray(KSUID_TIMESTAMP_BYTES + reserved));
  }

  return base62Encode(bytes, KSUID_STRING_LENGTH);
}

/** Decoded parts of a KSUID body: its mint timestamp and 16-byte payload. */
export type DecodedKsuid = {
  timestampSeconds: number;
  timestamp: Date;
  payload: Uint8Array;
};

/**
 * Decode a KSUID body (or a `prefix_<body>` friendly id) into its timestamp + 16-byte payload.
 * The inverse of generateKsuidId's layout. Throws if the body is not 27 base62 chars.
 */
export function decodeKsuid(idOrFriendlyId: string): DecodedKsuid {
  const underscore = idOrFriendlyId.indexOf("_");
  const body = underscore === -1 ? idOrFriendlyId : idOrFriendlyId.slice(underscore + 1);
  if (body.length !== KSUID_STRING_LENGTH) {
    throw new Error(
      `Not a KSUID body: expected ${KSUID_STRING_LENGTH} base62 chars, got ${body.length}`
    );
  }

  let n = BigInt(0);
  for (const ch of body) {
    const digit = BASE62_ALPHABET.indexOf(ch);
    if (digit < 0) {
      throw new Error(`Invalid base62 character in KSUID body: ${ch}`);
    }
    n = n * BigInt(62) + BigInt(digit);
  }

  const bytes = new Uint8Array(KSUID_TOTAL_BYTES);
  for (let i = KSUID_TOTAL_BYTES - 1; i >= 0; i--) {
    bytes[i] = Number(n & BigInt(0xff));
    n >>= BigInt(8);
  }

  const timestampSeconds =
    (bytes[0] ?? 0) * 0x1000000 +
    (bytes[1] ?? 0) * 0x10000 +
    (bytes[2] ?? 0) * 0x100 +
    (bytes[3] ?? 0) +
    KSUID_EPOCH;

  return {
    timestampSeconds,
    timestamp: new Date(timestampSeconds * 1000),
    payload: bytes.slice(KSUID_TIMESTAMP_BYTES),
  };
}

export function generateInternalId(): string {
  return cuid();
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
