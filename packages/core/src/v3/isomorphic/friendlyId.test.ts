import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunId,
  WaitpointId,
  SnapshotId,
  QueueId,
  setKsuidMintEnabled,
  isKsuidMintEnabled,
  generateKsuidId,
  decodeKsuid,
  KSUID_PAYLOAD_BYTES,
} from "./friendlyId.js";

const CUID_LEN = 25;
const KSUID_LEN = 27;

afterEach(() => setKsuidMintEnabled(false)); // never leak flag state across tests

describe("KSUID mint (flag-gated) for RunId + WaitpointId", () => {
  it("flag OFF: run + waitpoint mint cuid (25) and round-trip", () => {
    setKsuidMintEnabled(false);
    expect(isKsuidMintEnabled()).toBe(false);
    for (const util of [RunId, WaitpointId]) {
      const { id, friendlyId } = util.generate();
      expect(id.length).toBe(CUID_LEN);
      expect(util.fromFriendlyId(friendlyId)).toBe(id);
      expect(util.toId(friendlyId)).toBe(id);
      expect(util.toId(id)).toBe(id);
      expect(util.toFriendlyId(id)).toBe(friendlyId);
    }
  });

  it("flag ON: run + waitpoint mint 27-char and round-trip", () => {
    setKsuidMintEnabled(true);
    expect(isKsuidMintEnabled()).toBe(true);
    for (const util of [RunId, WaitpointId]) {
      const { id, friendlyId } = util.generate();
      expect(id.length).toBe(KSUID_LEN);
      expect(util.fromFriendlyId(friendlyId)).toBe(id);
      expect(util.toId(friendlyId)).toBe(id);
      expect(util.toId(id)).toBe(id);
      expect(util.toFriendlyId(id)).toBe(friendlyId);
    }
  });

  it("flag ON: SnapshotId stays cuid (25) — never 27-char", () => {
    setKsuidMintEnabled(true);
    const { id } = SnapshotId.generate();
    expect(id.length).toBe(CUID_LEN);
  });

  it("flag ON: a non-run/waitpoint entity stays cuid (25)", () => {
    setKsuidMintEnabled(true);
    expect(QueueId.generate().id.length).toBe(CUID_LEN);
  });

  it("disjoint lengths: 27 (new) vs 25 (cuid) — the classifier margin", () => {
    setKsuidMintEnabled(true);
    expect(RunId.generate().id.length).not.toBe(SnapshotId.generate().id.length);
  });

  it("generateKsuidId() is directly callable, independent of the flag", () => {
    setKsuidMintEnabled(false); // must NOT be gated behind the global flag
    expect(generateKsuidId().length).toBe(KSUID_LEN);
  });
});

describe("generateKsuidId is a genuine KSUID (decodable timestamp, time-ordered)", () => {
  const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const KSUID_EPOCH = 1_400_000_000;

  // Decode the 27-char base62 body back to the 4-byte timestamp prefix (unix seconds).
  function decodeTimestamp(id: string): number {
    let n = 0n;
    for (const ch of id) n = n * 62n + BigInt(BASE62.indexOf(ch));
    return Number(n >> 128n) + KSUID_EPOCH; // top 4 of the 20 bytes
  }

  afterEach(() => vi.useRealTimers());

  it("is exactly 27 base62 chars", () => {
    expect(generateKsuidId()).toMatch(/^[0-9A-Za-z]{27}$/);
  });

  it("carries a decodable timestamp within a few seconds of now", () => {
    const before = Math.floor(Date.now() / 1000);
    const ts = decodeTimestamp(generateKsuidId());
    expect(ts).toBeGreaterThanOrEqual(before - 2);
    expect(ts).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 2);
  });

  it("is k-sortable: ids from later seconds sort lexicographically after earlier ones", () => {
    vi.useFakeTimers();
    const ids: string[] = [];
    for (const t of ["2026-01-01T00:00:00Z", "2026-01-01T00:05:00Z", "2026-09-01T12:00:00Z"]) {
      vi.setSystemTime(new Date(t));
      ids.push(generateKsuidId());
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it("is unique across many mints in the same second", () => {
    const n = 1000;
    expect(new Set(Array.from({ length: n }, generateKsuidId)).size).toBe(n);
  });
});

describe("KSUID payload encode/decode (foundation primitive)", () => {
  it("round-trips a full 16-byte payload exactly", () => {
    const payload = new Uint8Array(KSUID_PAYLOAD_BYTES).map((_, i) => (i * 17 + 1) & 0xff);
    const { payload: decoded } = decodeKsuid(generateKsuidId(payload));
    expect(Array.from(decoded)).toEqual(Array.from(payload));
  });

  it("preserves a partial payload prefix and keeps the remainder for entropy", () => {
    const meta = new Uint8Array([9, 8, 7, 6]);
    const { payload } = decodeKsuid(generateKsuidId(meta));
    expect(Array.from(payload.slice(0, 4))).toEqual([9, 8, 7, 6]);
    expect(payload.length).toBe(KSUID_PAYLOAD_BYTES);
  });

  it("still carries a decodable timestamp when a payload is embedded", () => {
    const before = Math.floor(Date.now() / 1000);
    const { timestampSeconds } = decodeKsuid(generateKsuidId(new Uint8Array([1, 2, 3])));
    expect(timestampSeconds).toBeGreaterThanOrEqual(before - 2);
    expect(timestampSeconds).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 2);
  });

  it("stays 27 chars with a full payload and decodes through a friendlyId prefix", () => {
    const id = generateKsuidId(new Uint8Array(KSUID_PAYLOAD_BYTES).fill(0xab));
    expect(id).toMatch(/^[0-9A-Za-z]{27}$/);
    expect(Array.from(decodeKsuid(`run_${id}`).payload)).toEqual(
      new Array(KSUID_PAYLOAD_BYTES).fill(0xab)
    );
  });

  it("throws if the payload exceeds the 16-byte budget", () => {
    expect(() => generateKsuidId(new Uint8Array(KSUID_PAYLOAD_BYTES + 1))).toThrow();
  });

  it("decodeKsuid rejects a body that is not 27 base62 chars", () => {
    expect(() => decodeKsuid("run_tooShort")).toThrow();
  });
});
