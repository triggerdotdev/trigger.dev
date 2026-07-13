import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RunId,
  WaitpointId,
  SnapshotId,
  QueueId,
  RUN_OPS_ID_LENGTH,
  RUN_OPS_ID_REGION_INDEX,
  RUN_OPS_ID_VERSION,
  RUN_OPS_ID_VERSION_INDEX,
  base32hexDecode,
  base32hexEncode,
  generateRunOpsId,
  parseRunId,
} from "./friendlyId.js";

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
    expect(parseRunId(`run_${"a".repeat(25)}2`).format).toBe("legacy"); // wrong version
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
