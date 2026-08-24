import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunId,
  WaitpointId,
  SnapshotId,
  QueueId,
  WebhookDeliveryId,
  RUN_OPS_ID_LENGTH,
  RUN_OPS_ID_REGION_INDEX,
  RUN_OPS_ID_SHARD_INDEX,
  RUN_OPS_ID_VERSION,
  RUN_OPS_ID_VERSION_2,
  RUN_OPS_ID_VERSION_INDEX,
  base32hexDecode,
  base32hexEncode,
  generateRunOpsId,
  generateRunOpsIdV2,
  isValidShardChar,
  parseRunId,
  parseRunOpsIdBody,
  parseRunOpsIdV2Body,
} from "./friendlyId.js";

/** Every legal gen-2 shard char: the full DNS-safe lowercase range. */
const SHARD_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

const CUID_LEN = 25;

describe("RunId + WaitpointId mint cuid by default; run-ops v1 via generateRunOpsId", () => {
  it("default: run + waitpoint mint cuid (25) and round-trip", () => {
    for (const util of [RunId, WaitpointId]) {
      const { id, friendlyId } = util.generate();
      expect(id.length).toBe(CUID_LEN);
      expect(util.fromFriendlyId(friendlyId)).toBe(id);
      expect(util.toId(friendlyId)).toBe(id);
      expect(util.toId(id)).toBe(id);
      expect(util.toFriendlyId(id)).toBe(friendlyId);
    }
  });

  it("explicit run-ops id: a run/waitpoint friendlyId over generateRunOpsId() is 26-char and round-trips", () => {
    for (const util of [RunId, WaitpointId]) {
      const id = generateRunOpsId();
      const friendlyId = util.toFriendlyId(id);
      expect(id.length).toBe(RUN_OPS_ID_LENGTH);
      expect(util.fromFriendlyId(friendlyId)).toBe(id);
      expect(util.toId(friendlyId)).toBe(id);
      expect(util.toId(id)).toBe(id);
    }
  });

  it("SnapshotId + QueueId stay cuid (25)", () => {
    expect(SnapshotId.generate().id.length).toBe(CUID_LEN);
    expect(QueueId.generate().id.length).toBe(CUID_LEN);
  });
});

describe("base32hex codec (lowercase RFC 4648 §7)", () => {
  // Independent reference: interpret the bytes as one big-endian integer and
  // emit base-32 digits. Only exact multiples of 5 bytes (40 bits) are used, so
  // there is never a partial trailing group to disagree on.
  const ALPHA = "0123456789abcdefghijklmnopqrstuv";
  function referenceEncode(bytes: Uint8Array): string {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    const chars = (bytes.length * 8) / 5;
    let out = "";
    for (let i = 0; i < chars; i++) {
      out = ALPHA[Number(n & 31n)] + out;
      n >>= 5n;
    }
    return out;
  }

  it("matches the big-integer reference bit-for-bit (property, 5/10/15/20-byte inputs)", () => {
    for (let iter = 0; iter < 2_000; iter++) {
      for (const len of [5, 10, 15, 20]) {
        const bytes = new Uint8Array(len);
        crypto.getRandomValues(bytes);
        const encoded = base32hexEncode(bytes);
        expect(encoded).toBe(referenceEncode(bytes));
        expect(Array.from(base32hexDecode(encoded))).toEqual(Array.from(bytes));
      }
    }
  });

  it("hand-verified vectors", () => {
    expect(base32hexEncode(new Uint8Array(5))).toBe("00000000");
    expect(base32hexEncode(new Uint8Array(5).fill(0xff))).toBe("vvvvvvvv");
    expect(base32hexEncode(new Uint8Array([0, 0, 0, 0, 1]))).toBe("00000001");
    // 0x20 0 0 0 0 = 2^37; 2^37 / 32^7 = 4 → leading digit "4"
    expect(base32hexEncode(new Uint8Array([0x20, 0, 0, 0, 0]))).toBe("40000000");
  });

  it("decode rejects characters outside the lowercase base32hex alphabet", () => {
    for (const bad of ["w", "x", "z", "A", "V", "-", "_", " "]) {
      expect(() => base32hexDecode(`0000000${bad}`)).toThrow(/invalid/i);
    }
  });
});

describe("generateRunOpsId — run-ops v1 id spec", () => {
  afterEach(() => vi.useRealTimers());

  it("emits <24-char base32hex core><region char><version '1'> — 26 chars total", () => {
    const id = generateRunOpsId();
    expect(id.length).toBe(RUN_OPS_ID_LENGTH);
    expect(id).toMatch(/^[0-9a-v]{24}[a-z0-9]1$/);
    expect(id[RUN_OPS_ID_VERSION_INDEX]).toBe(RUN_OPS_ID_VERSION);
  });

  it("only ever uses lowercase [a-z0-9] and NEVER '-' (DNS-1123 / pod-name invariant)", () => {
    for (let i = 0; i < 5_000; i++) {
      const id = generateRunOpsId();
      expect(id).toMatch(/^[a-z0-9]+$/);
      expect(id).not.toContain("-");
    }
  });

  it("stamps the region char from REGION_CODES, defaulting to '0' when unknown/absent", () => {
    expect(generateRunOpsId("us-east-1")[RUN_OPS_ID_REGION_INDEX]).toBe("e");
    expect(generateRunOpsId("us-west-2")[RUN_OPS_ID_REGION_INDEX]).toBe("w");
    expect(generateRunOpsId("eu-central-1")[RUN_OPS_ID_REGION_INDEX]).toBe("c");
    expect(generateRunOpsId("mars-north-1")[RUN_OPS_ID_REGION_INDEX]).toBe("0");
    expect(generateRunOpsId()[RUN_OPS_ID_REGION_INDEX]).toBe("0");
  });

  it("sorts lexicographically in creation order at ms resolution (A@t, C@t+3ms, B@t+1s → A,C,B)", () => {
    vi.useFakeTimers();
    const t = new Date("2026-07-04T12:00:00.000Z").getTime();
    vi.setSystemTime(t);
    const a = generateRunOpsId();
    vi.setSystemTime(t + 1000);
    const b = generateRunOpsId();
    vi.setSystemTime(t + 3);
    const c = generateRunOpsId();
    expect([b, c, a].sort()).toEqual([a, c, b]);
  });

  it("decode recovers the exact ms timestamp", () => {
    vi.useFakeTimers();
    const t = new Date("2026-07-04T12:34:56.789Z");
    vi.setSystemTime(t);
    const parsed = parseRunId(`run_${generateRunOpsId("us-east-1")}`);
    expect(parsed.format).toBe("b32hex");
    if (parsed.format === "b32hex") {
      expect(parsed.timestamp.getTime()).toBe(t.getTime());
    }
  });

  it("is unique across many mints in the same ms (72 bits of CSPRNG)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T00:00:00.000Z"));
    const n = 2_000;
    expect(new Set(Array.from({ length: n }, () => generateRunOpsId())).size).toBe(n);
  });
});

describe("parseRunId — version-char discrimination (not length)", () => {
  it("parses a v1 friendly id as partitioned with region + version", () => {
    const parsed = parseRunId(`run_${generateRunOpsId("us-west-2")}`);
    expect(parsed).toMatchObject({
      format: "b32hex",
      table: "partitioned",
      region: "w",
      version: "1",
    });
  });

  it("classifies a cuid friendly id legacy", () => {
    expect(parseRunId(RunId.generate().friendlyId)).toEqual({
      format: "legacy",
      table: "legacy",
    });
  });

  it("classifies a nanoid-bodied friendly id and a run_-less id legacy", () => {
    expect(parseRunId("run_123456789abcdefghijkm").format).toBe("legacy"); // 21-char nanoid body
    expect(parseRunId(generateRunOpsId()).format).toBe("legacy"); // bare body, no run_ prefix
    expect(parseRunId("waitpoint_" + generateRunOpsId()).format).toBe("legacy"); // wrong prefix
  });

  it("falls back to legacy on a malformed v1 (bad alphabet / wrong version char)", () => {
    expect(parseRunId(`run_${"A".repeat(25)}1`).format).toBe("legacy"); // uppercase core
    expect(parseRunId(`run_${"a".repeat(25)}9`).format).toBe("legacy"); // unallocated version
    expect(parseRunId(`run_${"a".repeat(25)}2`).format).toBe("b32hexV2"); // "2" is now gen-2
    expect(parseRunId(`run_${"a".repeat(24)}-1`).format).toBe("legacy"); // region char not [a-z0-9]
    expect(parseRunId(`run_${"a".repeat(27)}`).format).toBe("legacy"); // old 27-char shape
  });
});

describe("firekeeper pod-name round-trip (runner-<id>[-attempt-N] → run_<id>)", () => {
  // Mirrors firekeeper's runIDFromPodName: strip "runner-", cut before the first
  // hyphen, prepend "run_". Works because a v1 id is all-lowercase [0-9a-v] and
  // NEVER contains "-" — the hyphens all belong to the pod-name delimiters.
  function firekeeperRunIdFromPodName(name: string): string {
    const rest = name.slice("runner-".length);
    const hyphen = rest.indexOf("-");
    return `run_${hyphen === -1 ? rest : rest.slice(0, hyphen)}`;
  }

  it("recovers the exact id (incl. region + version chars) from first-attempt and retry pods", () => {
    const id = generateRunOpsId("us-east-1");
    expect(firekeeperRunIdFromPodName(`runner-${id}`)).toBe(`run_${id}`);
    expect(firekeeperRunIdFromPodName(`runner-${id}-attempt-2`)).toBe(`run_${id}`);
    expect(parseRunId(firekeeperRunIdFromPodName(`runner-${id}-attempt-2`)).format).toBe("b32hex");
  });

  it("the recovered id is a valid DNS-1123 label body (k8s accepts runner-<id>)", () => {
    const podName = `runner-${generateRunOpsId("eu-central-1")}`;
    expect(podName).toMatch(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/);
    expect(podName.length).toBeLessThanOrEqual(63);
  });
});

describe("WebhookDeliveryId (time-encoded)", () => {
  it("generate() round-trips and parseTimestamp recovers the exact mint timestamp", () => {
    const { id, friendlyId, timestamp } = WebhookDeliveryId.generate();

    expect(friendlyId).toBe(`whd_${id}`);
    expect(id.length).toBe(25);
    expect(WebhookDeliveryId.toId(friendlyId)).toBe(id);
    expect(WebhookDeliveryId.toId(id)).toBe(id);
    expect(WebhookDeliveryId.toFriendlyId(id)).toBe(friendlyId);
    expect(WebhookDeliveryId.parseTimestamp(friendlyId)?.getTime()).toBe(timestamp.getTime());
    expect(WebhookDeliveryId.parseTimestamp(id)?.getTime()).toBe(timestamp.getTime());
  });

  it("encodes the wall-clock mint time so the partition key is recoverable", () => {
    vi.useFakeTimers();
    try {
      const minted = new Date("2026-08-09T12:34:56.789Z");
      vi.setSystemTime(minted);
      const { friendlyId, timestamp } = WebhookDeliveryId.generate();
      expect(timestamp.getTime()).toBe(minted.getTime());
      expect(WebhookDeliveryId.parseTimestamp(friendlyId)?.toISOString()).toBe(
        "2026-08-09T12:34:56.789Z"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sorts lexicographically in mint order at millisecond resolution", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-09T00:00:00.000Z"));
      const first = WebhookDeliveryId.generate().id;
      vi.setSystemTime(new Date("2026-08-09T00:00:00.001Z"));
      const second = WebhookDeliveryId.generate().id;
      expect(first < second).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns undefined for legacy or malformed ids so callers skip pruning", () => {
    expect(WebhookDeliveryId.parseTimestamp("whd_tooShort")).toBeUndefined();
    expect(WebhookDeliveryId.parseTimestamp(`whd_${"z".repeat(24)}1`)).toBeUndefined();
    expect(WebhookDeliveryId.parseTimestamp(`whd_${"0".repeat(24)}9`)).toBeUndefined();
  });
});

describe("generateRunOpsIdV2 — gen-2 id spec (shard char at 24, version '2' at 25)", () => {
  afterEach(() => vi.useRealTimers());

  it("emits <24-char base32hex core><shard char><version '2'> — 26 chars total", () => {
    const id = generateRunOpsIdV2("a");
    expect(id.length).toBe(RUN_OPS_ID_LENGTH);
    expect(id).toMatch(/^[0-9a-v]{24}[a-z0-9]2$/);
    expect(id[RUN_OPS_ID_VERSION_INDEX]).toBe(RUN_OPS_ID_VERSION_2);
    expect(id[RUN_OPS_ID_SHARD_INDEX]).toBe("a");
  });

  it("round-trips every legal shard char [a-z0-9] through parseRunOpsIdV2Body", () => {
    for (const c of SHARD_CHARS) {
      const id = generateRunOpsIdV2(c);
      const parsed = parseRunOpsIdV2Body(id);
      expect(parsed).toBeDefined();
      expect(parsed?.shard).toBe(c);
      expect(parsed?.version).toBe(RUN_OPS_ID_VERSION_2);
      // the core survives the round-trip: its bytes re-encode to the id's first 24 chars
      expect(base32hexEncode(base32hexDecode(id.slice(0, 24)))).toBe(id.slice(0, 24));
    }
  });

  it("throws on a shard char outside [a-z0-9] (fail loud, never mint an unroutable id)", () => {
    for (const bad of ["", "-", "_", "A", "ab", " ", "/"]) {
      expect(() => generateRunOpsIdV2(bad)).toThrow(/shard/i);
    }
  });

  it("only ever uses lowercase [a-z0-9] and NEVER '-' (DNS-1123 / pod-name invariant)", () => {
    for (let i = 0; i < 5_000; i++) {
      const id = generateRunOpsIdV2(SHARD_CHARS[i % SHARD_CHARS.length]!);
      expect(id).toMatch(/^[a-z0-9]+$/);
      expect(id).not.toContain("-");
    }
  });

  it("sorts lexicographically in creation order at ms resolution, like gen-1", () => {
    vi.useFakeTimers();
    const t = new Date("2026-07-04T12:00:00.000Z").getTime();
    vi.setSystemTime(t);
    const a = generateRunOpsIdV2("a");
    vi.setSystemTime(t + 1000);
    const b = generateRunOpsIdV2("a");
    vi.setSystemTime(t + 3);
    const c = generateRunOpsIdV2("a");
    expect([b, c, a].sort()).toEqual([a, c, b]);
  });

  it("decode recovers the exact ms timestamp", () => {
    vi.useFakeTimers();
    const t = new Date("2026-07-04T12:34:56.789Z");
    vi.setSystemTime(t);
    expect(parseRunOpsIdV2Body(generateRunOpsIdV2("e"))?.timestamp.getTime()).toBe(t.getTime());
  });

  it("is unique across many mints in the same ms (72 bits of CSPRNG)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T00:00:00.000Z"));
    const n = 2_000;
    expect(new Set(Array.from({ length: n }, () => generateRunOpsIdV2("a"))).size).toBe(n);
  });
});

describe("parseRunOpsIdV2Body — the mirror of the v1 shape check", () => {
  it("rejects a body that is not exactly 26 chars", () => {
    const core = "a".repeat(24);
    expect(parseRunOpsIdV2Body("")).toBeUndefined();
    expect(parseRunOpsIdV2Body(`${core}2`)).toBeUndefined(); // 25
    expect(parseRunOpsIdV2Body(`${core}ee2`)).toBeUndefined(); // 27
    expect(parseRunOpsIdV2Body("a".repeat(40))).toBeUndefined();
  });

  it("rejects a body without '2' at index 25", () => {
    const core = "a".repeat(24);
    for (const version of ["1", "0", "3", "z", "-"]) {
      expect(parseRunOpsIdV2Body(`${core}e${version}`)).toBeUndefined();
    }
  });

  it("rejects a body whose 24-char core is not base32hex", () => {
    for (const badCore of ["w".repeat(24), "z".repeat(24), "A".repeat(24), `${"a".repeat(23)}-`]) {
      expect(parseRunOpsIdV2Body(`${badCore}e2`)).toBeUndefined();
    }
  });

  it("rejects a body whose char at index 24 is outside [a-z0-9]", () => {
    const core = "a".repeat(24);
    for (const badShard of ["-", "_", "A", ".", " "]) {
      expect(parseRunOpsIdV2Body(`${core}${badShard}2`)).toBeUndefined();
    }
  });

  it("never throws, for any input string", () => {
    for (const input of ["", "x", "-".repeat(26), " ".repeat(26), "\u{1F642}".repeat(26)]) {
      expect(() => parseRunOpsIdV2Body(input)).not.toThrow();
    }
  });
});

describe("gen-1 and gen-2 parsers reject each other (the disjointness foundation)", () => {
  it("parseRunOpsIdBody rejects every gen-2 id", () => {
    for (const c of SHARD_CHARS) {
      expect(parseRunOpsIdBody(generateRunOpsIdV2(c))).toBeUndefined();
    }
  });

  it("parseRunOpsIdV2Body rejects every gen-1 v1 id", () => {
    for (const region of [undefined, "us-east-1", "us-west-2", "eu-central-1"]) {
      expect(parseRunOpsIdV2Body(generateRunOpsId(region))).toBeUndefined();
    }
  });

  it("generateRunOpsId still mints v1 ids — the gen-1 generator is unchanged", () => {
    const id = generateRunOpsId("us-east-1");
    expect(id).toMatch(/^[0-9a-v]{24}[a-z0-9]1$/);
    expect(id[RUN_OPS_ID_VERSION_INDEX]).toBe(RUN_OPS_ID_VERSION);
    expect(parseRunOpsIdBody(id)?.region).toBe("e");
  });

  it("the shard index and the region index are the same position", () => {
    expect(RUN_OPS_ID_SHARD_INDEX).toBe(RUN_OPS_ID_REGION_INDEX);
  });
});

describe("parseRunId — v2 arm", () => {
  it("parses a gen-2 friendly id as partitioned with its shard + version", () => {
    const parsed = parseRunId(`run_${generateRunOpsIdV2("e")}`);
    expect(parsed).toMatchObject({
      format: "b32hexV2",
      table: "partitioned",
      shard: "e",
      version: "2",
    });
  });

  it("still parses a gen-1 v1 friendly id as b32hex — the v1 arm is unchanged", () => {
    expect(parseRunId(`run_${generateRunOpsId("us-west-2")}`)).toMatchObject({
      format: "b32hex",
      table: "partitioned",
      region: "w",
      version: "1",
    });
  });

  it("classifies a gen-2 body without the run_ prefix, and under a wrong prefix, legacy", () => {
    expect(parseRunId(generateRunOpsIdV2("a")).format).toBe("legacy");
    expect(parseRunId(`waitpoint_${generateRunOpsIdV2("a")}`).format).toBe("legacy");
  });
});

describe("isValidShardChar", () => {
  it("accepts a single [a-z0-9] char", () => {
    expect(isValidShardChar("a")).toBe(true);
    expect(isValidShardChar("0")).toBe(true);
    expect(isValidShardChar("w")).toBe(true);
  });
  it("rejects multi-char, empty, uppercase, and punctuation", () => {
    expect(isValidShardChar("")).toBe(false);
    expect(isValidShardChar("ab")).toBe(false);
    expect(isValidShardChar("A")).toBe(false);
    expect(isValidShardChar("-")).toBe(false);
    expect(isValidShardChar("legacy")).toBe(false);
  });
});
