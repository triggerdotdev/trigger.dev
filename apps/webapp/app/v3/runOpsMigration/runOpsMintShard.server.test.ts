import { describe, expect, it } from "vitest";
import { computeMintShard, type MintShardDeps } from "./runOpsMintShard.server";
import { type MintShardSetResolution } from "./mintShardGrace";

const GRACE_MS = 90_000;
const T = 1_000_000;

// Cuid-shaped ids, not sequential integers: a sequential space does not model the real
// key distribution the hash has to spread.
function envIds(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(`cm${(i * 2654435761).toString(36).padStart(10, "0")}${i.toString(36)}zzq`);
  }
  return ids;
}

const ALL_KEYS = "abcdefghijklmnopqrstuvwxyz0123456789".split("");

function deps(
  resolution: MintShardSetResolution,
  overrides: Partial<MintShardDeps> = {}
): MintShardDeps {
  return {
    resolution,
    ceiling: ALL_KEYS,
    nowMs: T + GRACE_MS + 1,
    graceMs: GRACE_MS,
    orgFeatureFlags: undefined,
    ...overrides,
  };
}

function orgFlags(flags: Record<string, unknown>) {
  return { orgFeatureFlags: flags };
}

function place(ids: string[], resolution: MintShardSetResolution): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    out.set(id, computeMintShard({ id }, deps(resolution)));
  }
  return out;
}

describe("computeMintShard — the no-shards answer", () => {
  it("returns new when the live list is empty", () => {
    expect(computeMintShard({ id: "env_1" }, deps({ set: [] }))).toBe("new");
  });

  it("returns new when the deployment configures no ceiling", () => {
    // An unconfigured deployment is an unconditional kill switch, whatever the stored list says.
    const resolution: MintShardSetResolution = { set: ["a", "b"] };
    expect(computeMintShard({ id: "env_1" }, deps(resolution, { ceiling: [] }))).toBe("new");
  });

  it("returns new when the stored list names nothing this deployment can route", () => {
    const resolution: MintShardSetResolution = { set: ["z"] };
    expect(computeMintShard({ id: "env_1" }, deps(resolution, { ceiling: ["a"] }))).toBe("new");
  });

  it("returns new when the ceiling is empty even with a stale stamp present", () => {
    const resolution: MintShardSetResolution = { set: [], prevSet: ["a"], flippedAtMs: T };
    // The ceiling gate MUST run before the grace, so no stored value can reopen a closed switch.
    expect(computeMintShard({ id: "env_1" }, deps(resolution, { nowMs: T + 1, ceiling: [] }))).toBe(
      "new"
    );
  });

  it("returns new when the grace serves an empty prevSet", () => {
    const resolution: MintShardSetResolution = { set: ["a"], prevSet: [], flippedAtMs: T };
    expect(computeMintShard({ id: "env_1" }, deps(resolution, { nowMs: T + 1 }))).toBe("new");
  });
});

describe("computeMintShard — determinism", () => {
  it("returns the same value for the same environment on every call", () => {
    const resolution: MintShardSetResolution = { set: ["a", "b", "c"] };
    const first = computeMintShard({ id: "env_stable" }, deps(resolution));
    for (let i = 0; i < 1000; i++) {
      expect(computeMintShard({ id: "env_stable" }, deps(resolution))).toBe(first);
    }
  });

  it("ignores the order the operator listed the keys in", () => {
    const ids = envIds(200);
    const canonical = place(ids, { set: ["a", "b", "c"] });
    for (const permutation of [
      ["c", "b", "a"],
      ["b", "a", "c"],
      ["a", "c", "b"],
    ]) {
      expect(place(ids, { set: permutation })).toEqual(canonical);
    }
  });
});

describe("computeMintShard — pins", () => {
  const resolution: MintShardSetResolution = { set: ["a", "b"] };

  it("lets a per-env pin override the hash", () => {
    const ids = envIds(50);
    for (const id of ids) {
      const pinned = computeMintShard(
        { id },
        deps(resolution, orgFlags({ runOpsMintShardEnvPins: JSON.stringify({ [id]: "b" }) }))
      );
      expect(pinned).toBe("b");
    }
  });

  it("lets a per-org pin override the hash when no per-env pin is set", () => {
    const ids = envIds(50);
    for (const id of ids) {
      expect(computeMintShard({ id }, deps(resolution, orgFlags({ runOpsMintShard: "a" })))).toBe(
        "a"
      );
    }
  });

  it("lets a per-env pin beat a per-org pin", () => {
    const result = computeMintShard(
      { id: "env_1" },
      deps(
        resolution,
        orgFlags({
          runOpsMintShard: "a",
          runOpsMintShardEnvPins: JSON.stringify({ env_1: "b" }),
        })
      )
    );
    expect(result).toBe("b");
  });

  it("holds an environment on gen-1 when the pin is new", () => {
    expect(
      computeMintShard({ id: "env_1" }, deps(resolution, orgFlags({ runOpsMintShard: "new" })))
    ).toBe("new");
    expect(
      computeMintShard(
        { id: "env_1" },
        deps(resolution, orgFlags({ runOpsMintShardEnvPins: JSON.stringify({ env_1: "new" }) }))
      )
    ).toBe("new");
  });

  it("falls through to the hash and reports when the pin is outside the active set", () => {
    // Honouring a drained pin would leak the drain; throwing would fail customer triggers.
    const rejected: string[] = [];
    const result = computeMintShard(
      { id: "env_1" },
      deps(resolution, {
        ...orgFlags({ runOpsMintShard: "z" }),
        onPinRejected: (info) => rejected.push(info.pin),
      })
    );
    expect(result).toBe(computeMintShard({ id: "env_1" }, deps(resolution)));
    expect(rejected).toEqual(["z"]);
  });

  it("honours a pin to a drained key for the whole grace window, then falls through", () => {
    const draining: MintShardSetResolution = { set: ["a"], prevSet: ["a", "b"], flippedAtMs: T };
    const pinnedToB = orgFlags({ runOpsMintShard: "b" });
    expect(computeMintShard({ id: "env_1" }, deps(draining, { ...pinnedToB, nowMs: T + 1 }))).toBe(
      "b"
    );
    expect(
      computeMintShard({ id: "env_1" }, deps(draining, { ...pinnedToB, nowMs: T + GRACE_MS }))
    ).not.toBe("b");
  });

  it("ignores an unparseable pin blob rather than un-pinning silently", () => {
    const result = computeMintShard(
      { id: "env_1" },
      deps(resolution, orgFlags({ runOpsMintShard: "a", runOpsMintShardEnvPins: "{not json" }))
    );
    expect(result).toBe("a");
  });

  it("falls back to the org pin when the blob holds an invalid value for this env", () => {
    const result = computeMintShard(
      { id: "env_1" },
      deps(
        resolution,
        orgFlags({
          runOpsMintShard: "a",
          runOpsMintShardEnvPins: JSON.stringify({ env_1: "LEGACY" }),
        })
      )
    );
    expect(result).toBe("a");
  });

  it("ignores an invalid org pin value", () => {
    const result = computeMintShard(
      { id: "env_1" },
      deps(resolution, orgFlags({ runOpsMintShard: "legacy" }))
    );
    expect(result).toBe(computeMintShard({ id: "env_1" }, deps(resolution)));
  });
});

describe("computeMintShard — rendezvous properties", () => {
  const ids = envIds(10_000);

  it("spreads roughly evenly across the active set", () => {
    for (const set of [
      ["a", "b"],
      ["a", "b", "c"],
      ["a", "b", "c", "d"],
    ]) {
      const counts = new Map<string, number>();
      for (const shard of place(ids, { set }).values()) {
        counts.set(shard, (counts.get(shard) ?? 0) + 1);
      }
      expect(counts.size).toBe(set.length);
      const expected = ids.length / set.length;
      for (const count of counts.values()) {
        expect(Math.abs(count - expected) / expected).toBeLessThan(0.1);
      }
    }
  });

  it("moves about 1/(N+1) of environments when a shard is added", () => {
    const cases: Array<{ from: string[]; to: string[]; expected: number }> = [
      { from: ["a"], to: ["a", "b"], expected: 1 / 2 },
      { from: ["a", "b"], to: ["a", "b", "c"], expected: 1 / 3 },
      { from: ["a", "b", "c"], to: ["a", "b", "c", "d"], expected: 1 / 4 },
    ];

    for (const { from, to, expected } of cases) {
      const before = place(ids, { set: from });
      const after = place(ids, { set: to });
      const added = to.filter((k) => !from.includes(k));
      let moved = 0;
      for (const id of ids) {
        if (before.get(id) === after.get(id)) continue;
        moved++;
        // HRW's defining property: a mover lands on the ADDED shard, never on a survivor.
        expect(added).toContain(after.get(id));
      }
      expect(Math.abs(moved / ids.length - expected) / expected).toBeLessThan(0.1);
    }
  });

  it("moves only the environments that hashed to a removed shard", () => {
    const before = place(ids, { set: ["a", "b", "c"] });
    const after = place(ids, { set: ["a", "b"] });
    for (const id of ids) {
      if (before.get(id) === "c") {
        expect(after.get(id)).not.toBe("c");
      } else {
        expect(after.get(id)).toBe(before.get(id));
      }
    }
  });

  it("also moves pinned environments when their shard is removed", () => {
    // Criterion 6 is a property of the hash only. A pin to a removed key moves too.
    const pinnedToC = orgFlags({ runOpsMintShard: "c" });
    expect(computeMintShard({ id: "env_1" }, deps({ set: ["a", "b", "c"] }, pinnedToC))).toBe("c");
    expect(computeMintShard({ id: "env_1" }, deps({ set: ["a", "b"] }, pinnedToC))).not.toBe("c");
  });
});

describe("computeMintShard — the ceiling bounds the stored list", () => {
  it("mints only into keys the deployment can route", () => {
    const resolution: MintShardSetResolution = { set: ["a", "b", "c"] };
    const ids = envIds(300);
    for (const id of ids) {
      const shard = computeMintShard({ id }, deps(resolution, { ceiling: ["a", "b"] }));
      expect(["a", "b"]).toContain(shard);
    }
  });

  it("ignores a pin to a key outside the ceiling", () => {
    const resolution: MintShardSetResolution = { set: ["a", "c"] };
    const rejected: string[] = [];
    const shard = computeMintShard(
      { id: "env_1" },
      deps(resolution, {
        ceiling: ["a"],
        orgFeatureFlags: { runOpsMintShard: "c" },
        onPinRejected: (info) => rejected.push(info.pin),
      })
    );
    expect(shard).toBe("a");
    expect(rejected).toEqual(["c"]);
  });

  it("still honours a gen-1 pin when the ceiling is narrower than the stored list", () => {
    const resolution: MintShardSetResolution = { set: ["a", "b"] };
    const shard = computeMintShard(
      { id: "env_1" },
      deps(resolution, { ceiling: ["a"], orgFeatureFlags: { runOpsMintShard: "new" } })
    );
    expect(shard).toBe("new");
  });
});
