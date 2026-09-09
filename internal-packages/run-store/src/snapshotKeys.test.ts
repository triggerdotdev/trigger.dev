// Topology + versioned key-layout lock (M2). Pure unit tests: the partition function, the {pNNN}
// hash tag, the versioned namespace, and same-slot co-location proven with the shared slotOf helper
// (a standalone Redis testcontainer cannot detect CROSSSLOT, so slot equality is asserted directly).
import { describe, expect, it } from "vitest";
import { slotOf } from "@internal/testcontainers";
import {
  PENDING_PARTITION_COUNT,
  SNAPSHOT_NAMESPACE,
  SNAPSHOT_STATE_VERSION,
  partitionTag,
  pendingStreamKey,
  pendingStreamKeyForRun,
  preparedUnitKey,
  residencyKey,
  runToPartition,
  snapshotKeys,
} from "./snapshotKeys.js";

describe("runToPartition", () => {
  it("is fixed at 256 partitions", () => {
    expect(PENDING_PARTITION_COUNT).toBe(256);
  });

  it("maps every run into 0..255", () => {
    for (let n = 0; n < 2000; n++) {
      const p = runToPartition(`run_${n}`);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(256);
      expect(Number.isInteger(p)).toBe(true);
    }
  });

  it("is deterministic and pod-independent (crc32 mod 256)", () => {
    // Pinned values: crc32 is the ISO-HDLC polynomial, identical on every pod, so these must never
    // drift. A different partition function would silently re-shard every run.
    expect(runToPartition("run_abc123")).toBe(3309210209 % 256);
    expect(runToPartition("run_1")).toBe(151);
    expect(runToPartition("run_2")).toBe(45);
    expect(runToPartition("run_1")).toBe(runToPartition("run_1"));
  });

  it("spreads runs across many partitions (not a constant)", () => {
    const seen = new Set<number>();
    for (let n = 0; n < 5000; n++) seen.add(runToPartition(`run_${n}`));
    expect(seen.size).toBeGreaterThan(200);
  });
});

describe("partitionTag", () => {
  it("zero-pads to three digits", () => {
    expect(partitionTag(0)).toBe("p000");
    expect(partitionTag(7)).toBe("p007");
    expect(partitionTag(42)).toBe("p042");
    expect(partitionTag(255)).toBe("p255");
  });
});

describe("snapshotKeys", () => {
  it("keys every core key under the versioned namespace and the partition hash tag", () => {
    const tag = partitionTag(runToPartition("run_1"));
    const k = snapshotKeys("run_1");
    expect(k.e).toBe(`${SNAPSHOT_NAMESPACE}:run:{${tag}}:run_1:e`);
    expect(k.idx).toBe(`${SNAPSHOT_NAMESPACE}:run:{${tag}}:run_1:idx`);
    expect(k.cur).toBe(`${SNAPSHOT_NAMESPACE}:run:{${tag}}:run_1:cur`);
    expect(k.seq).toBe(`${SNAPSHOT_NAMESPACE}:run:{${tag}}:run_1:seq`);
  });

  it("returns exactly the four core state keys", () => {
    expect(Object.keys(snapshotKeys("run_1")).sort()).toEqual(["cur", "e", "idx", "seq"]);
  });

  it("derives wp cycle keys from the entry key with the same tag", () => {
    // The Lua prelude strips ':e' and appends ':wp:<n>'. Reproduce it so the derived key keeps the
    // partition tag (and would keep the cluster slot).
    const k = snapshotKeys("run_1");
    const base = k.e.slice(0, -2);
    const tag = partitionTag(runToPartition("run_1"));
    expect(`${base}:wp:1`).toBe(`${SNAPSHOT_NAMESPACE}:run:{${tag}}:run_1:wp:1`);
  });
});

describe("residency / prepared / pending keys", () => {
  it("places the residency marker under res: with the partition tag", () => {
    const tag = partitionTag(runToPartition("run_1"));
    expect(residencyKey("run_1")).toBe(`${SNAPSHOT_NAMESPACE}:res:{${tag}}:run_1`);
  });

  it("places the prepared-unit key under prep: with the partition tag", () => {
    const tag = partitionTag(runToPartition("run_1"));
    expect(preparedUnitKey("run_1")).toBe(`${SNAPSHOT_NAMESPACE}:prep:{${tag}}:run_1`);
  });

  it("names the partition pending stream by ordinal", () => {
    expect(pendingStreamKey(7)).toBe(`${SNAPSHOT_NAMESPACE}:pending:{p007}`);
    expect(pendingStreamKeyForRun("run_1")).toBe(pendingStreamKey(runToPartition("run_1")));
  });
});

describe("cluster slot co-location", () => {
  it("puts a run's state, residency, prepared unit and its partition stream in ONE slot", () => {
    const k = snapshotKeys("run_1");
    const base = k.e.slice(0, -2);
    const keys = [
      k.e,
      k.idx,
      k.cur,
      k.seq,
      `${base}:wp:1`,
      `${base}:wp:2`,
      residencyKey("run_1"),
      preparedUnitKey("run_1"),
      pendingStreamKeyForRun("run_1"),
    ];
    const slots = new Set(keys.map(slotOf));
    expect(slots.size).toBe(1);
  });

  it("holds even through a client keyPrefix", () => {
    // ioredis prepends the prefix to the whole key, so the {pNNN} tag still governs the slot.
    const k = snapshotKeys("run_9");
    const base = k.e.slice(0, -2);
    const keys = [
      k.e,
      k.seq,
      `${base}:wp:1`,
      residencyKey("run_9"),
      pendingStreamKeyForRun("run_9"),
    ];
    const slots = new Set(keys.map((key) => slotOf(`engine:${key}`)));
    expect(slots.size).toBe(1);
  });

  it("separates runs whose partitions differ", () => {
    // run_1 -> p151, run_2 -> p045: distinct partitions must land in distinct slots so recovery
    // work is genuinely spread, not funnelled into one slot.
    expect(runToPartition("run_1")).not.toBe(runToPartition("run_2"));
    expect(slotOf(pendingStreamKeyForRun("run_1"))).not.toBe(
      slotOf(pendingStreamKeyForRun("run_2"))
    );
  });
});

describe("versioned namespace", () => {
  it("prefixes every key with snap:v1", () => {
    expect(SNAPSHOT_NAMESPACE).toBe("snap:v1");
    expect(SNAPSHOT_STATE_VERSION).toBe("1");
    const k = snapshotKeys("run_x");
    for (const key of [
      k.e,
      residencyKey("run_x"),
      preparedUnitKey("run_x"),
      pendingStreamKeyForRun("run_x"),
    ]) {
      expect(key.startsWith("snap:v1:")).toBe(true);
    }
  });
});
