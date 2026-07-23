import { customAlphabet } from "nanoid";
import cuid from "@bugsnag/cuid";

const idGenerator = customAlphabet("123456789abcdefghijkmnopqrstuvwxyz", 21);

export function generateFriendlyId(prefix: string, size?: number) {
  return `${prefix}_${idGenerator(size)}`;
}

// Run-ops v1 id: `<24-char base32hex core><region char><version char>` — 26 chars.
// Core = 6-byte big-endian unix ms timestamp + 9 bytes CSPRNG. Invariants:
//  - alphabet is lowercase [a-z0-9] (base32hex is [0-9a-v]): DNS-1123 safe for
//    k8s pod names, and byte order == lexicographic order, so ids sort in mint
//    order at ms resolution;
//  - the id NEVER contains "-" — that delimiter belongs to pod-name suffixes
//    (`runner-<id>-attempt-N`), so the id round-trips through a pod name by
//    cutting at the first hyphen;
//  - the `run_` (friendly) and `runner-` (pod) prefixes are part of the spec:
//    they guarantee the k8s name starts with a letter even though a base32hex
//    core can start with a digit.
const RUN_OPS_ID_ALPHABET = "0123456789abcdefghijklmnopqrstuv"; // base32hex, lowercase (RFC 4648 §7)
export const RUN_OPS_ID_LENGTH = 26;
export const RUN_OPS_ID_REGION_INDEX = 24;
export const RUN_OPS_ID_VERSION_INDEX = 25;
export const RUN_OPS_ID_VERSION = "1";
const RUN_OPS_ID_CORE_BYTES = 15; // 6 timestamp + 9 random → exactly 24 base32hex chars
const RUN_OPS_ID_CORE_LENGTH = 24;
const RUN_OPS_ID_TIMESTAMP_BYTES = 6;

/** Region char stamped when the region is unknown or unmapped at mint. */
export const DEFAULT_REGION_CHAR = "0";
// The region char is a raw positional char (readable via charAt before any
// decoding), NOT part of the base32hex core — so it may use the full DNS-safe
// lowercase [a-z0-9] range (e.g. "w" for us-west-2, which is outside [0-9a-v]).
const REGION_CHAR_PATTERN = /^[a-z0-9]$/;
/** One lowercase [a-z0-9] char per supported region, at RUN_OPS_ID_REGION_INDEX. */
export const REGION_CODES: Readonly<Record<string, string>> = {
  "us-east-1": "e",
  "us-west-2": "w",
  "eu-central-1": "c",
};

export function regionCharForRegion(region: string | undefined): string {
  return (region && REGION_CODES[region]) || DEFAULT_REGION_CHAR;
}

// globalThis.crypto is absent on Node 18.20 (a supported engine) without a flag, so fall back to
// node:crypto's webcrypto, loaded only when the global is missing to stay isomorphic.
type RandomFiller = (array: Uint8Array<ArrayBuffer>) => void;

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
// widely-used module never throws when crypto is unavailable — only minting an id would.
let cachedGetRandomValues: RandomFiller | undefined;
const getRandomValues: RandomFiller = (array) =>
  (cachedGetRandomValues ??= resolveGetRandomValues())(array);

/** Lowercase base32hex (RFC 4648 §7): 5 bits per char, order-preserving, no padding. */
export function base32hexEncode(bytes: Uint8Array): string {
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += RUN_OPS_ID_ALPHABET[(buf >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** Inverse of base32hexEncode. Throws on characters outside the lowercase alphabet. */
export function base32hexDecode(s: string): Uint8Array {
  const out: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const c of s) {
    const v = RUN_OPS_ID_ALPHABET.indexOf(c);
    if (v === -1) {
      throw new Error(`invalid run id char: ${c}`);
    }
    buf = (buf << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((buf >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/**
 * Mint a run-ops v1 id body (26 chars, no prefix): 24-char base32hex core
 * (6-byte ms timestamp + 9 CSPRNG bytes) + region char + version char "1".
 * The trailing version char at RUN_OPS_ID_VERSION_INDEX is the residency
 * discriminator — see runOpsResidency.ts.
 */
export function generateRunOpsId(region?: string): string {
  const core = new Uint8Array(RUN_OPS_ID_CORE_BYTES);

  let ms = Date.now();
  for (let i = RUN_OPS_ID_TIMESTAMP_BYTES - 1; i >= 0; i--) {
    core[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  getRandomValues(core.subarray(RUN_OPS_ID_TIMESTAMP_BYTES));

  return `${base32hexEncode(core)}${regionCharForRegion(region)}${RUN_OPS_ID_VERSION}`;
}

export type ParsedRunId =
  | { format: "b32hex"; table: "partitioned"; timestamp: Date; region: string; version: string }
  | { format: "legacy"; table: "legacy" };

const LEGACY_RUN_ID: ParsedRunId = { format: "legacy", table: "legacy" };

/**
 * Parse a v1 id body (no prefix). Returns undefined unless the body is exactly
 * 26 chars with version "1" at index 25 and every char inside the base32hex
 * alphabet — anything else (cuid, nanoid, pre-cutover 27-char base62, malformed
 * v1) is a legacy shape.
 */
export function parseRunOpsIdBody(
  body: string
): { timestamp: Date; region: string; version: string } | undefined {
  if (body.length !== RUN_OPS_ID_LENGTH) return undefined;
  if (body[RUN_OPS_ID_VERSION_INDEX] !== RUN_OPS_ID_VERSION) return undefined;
  const region = body[RUN_OPS_ID_REGION_INDEX] ?? "";
  if (!REGION_CHAR_PATTERN.test(region)) return undefined;

  let core: Uint8Array;
  try {
    core = base32hexDecode(body.slice(0, RUN_OPS_ID_CORE_LENGTH));
  } catch {
    return undefined;
  }

  let ms = 0;
  for (let i = 0; i < RUN_OPS_ID_TIMESTAMP_BYTES; i++) {
    ms = ms * 256 + (core[i] ?? 0);
  }

  return { timestamp: new Date(ms), region, version: RUN_OPS_ID_VERSION };
}

/** True if the (prefixless) id body is a well-formed run-ops v1 id. */
export function isRunOpsIdBody(body: string): boolean {
  return parseRunOpsIdBody(body) !== undefined;
}

/** Parse a `run_`-prefixed friendly id; anything not a well-formed v1 id is legacy. */
export function parseRunId(id: string): ParsedRunId {
  if (!id.startsWith("run_")) return LEGACY_RUN_ID;
  const parsed = parseRunOpsIdBody(id.slice(4));
  return parsed ? { format: "b32hex", table: "partitioned", ...parsed } : LEGACY_RUN_ID;
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
