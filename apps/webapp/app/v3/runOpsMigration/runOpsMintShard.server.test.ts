import { describe, expect, it } from "vitest";
import {
  computeMintShard,
  resolveMintShardWith,
  type MintShardCache,
  type MintShardDeps,
  type ResolveMintShardDeps,
} from "./runOpsMintShard.server";
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

function deps(
  resolution: MintShardSetResolution,
  overrides: Partial<MintShardDeps> = {}
): MintShardDeps {
  return {
    resolution,
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

  it("returns new when a stale stamp is present but both lists are empty", () => {
    const resolution: MintShardSetResolution = { set: [], prevSet: [], flippedAtMs: T };
    expect(computeMintShard({ id: "env_1" }, deps(resolution, { nowMs: T + 1 }))).toBe("new");
  });

  it("returns new when the grace serves an empty list", () => {
    const resolution: MintShardSetResolution = { set: ["a"], prevSet: [], flippedAtMs: T };
    expect(computeMintShard({ id: "env_1" }, deps(resolution, { nowMs: T + 1 }))).toBe("new");
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

describe("resolveMintShardWith — cache, read failure and fail-safe", () => {
  function wrapperDeps(
    overrides: Partial<ResolveMintShardDeps> = {}
  ): ResolveMintShardDeps & { reads: number } {
    const state = {
      readFlags: async () => ({ runOpsMintShardSet: "a,b" }),
      cache: { current: undefined as MintShardCache },
      nowMs: T,
      ttlMs: 30_000,
      graceMs: GRACE_MS,
      orgFeatureFlags: undefined as unknown,
      reads: 0,
      ...overrides,
    };
    const wrapped = state.readFlags;
    state.readFlags = async () => {
      state.reads++;
      return wrapped();
    };
    return state;
  }

  it("reads once, then serves the cache until the TTL expires", async () => {
    const deps = wrapperDeps();
    await resolveMintShardWith({ id: "env_1" }, deps);
    await resolveMintShardWith({ id: "env_2" }, deps);
    await resolveMintShardWith({ id: "env_3" }, deps);
    expect(deps.reads).toBe(1);
  });

  it("reads again once the TTL expires", async () => {
    const deps = wrapperDeps();
    await resolveMintShardWith({ id: "env_1" }, deps);
    deps.nowMs = T + 30_000;
    await resolveMintShardWith({ id: "env_1" }, deps);
    expect(deps.reads).toBe(2);
  });

  it("falls back to gen-1 when the read throws, and does not poison the cache", async () => {
    // A blip must not move every environment's placement, so it returns gen-1 rather than guess.
    let fail = true;
    const deps = wrapperDeps({
      readFlags: async () => {
        if (fail) throw new Error("db down");
        return { runOpsMintShardSet: "a,b" };
      },
    });
    const failures: unknown[] = [];
    deps.onReadFailed = (error) => failures.push(error);

    expect(await resolveMintShardWith({ id: "env_1" }, deps)).toBe("new");
    expect(failures).toHaveLength(1);

    fail = false;
    expect(["a", "b"]).toContain(await resolveMintShardWith({ id: "env_1" }, deps));
  });

  it("returns gen-1 when the stored list is empty", async () => {
    const deps = wrapperDeps({ readFlags: async () => ({ runOpsMintShardSet: "" }) });
    expect(await resolveMintShardWith({ id: "env_1" }, deps)).toBe("new");
  });

  it("agrees with the pure core for the same inputs", async () => {
    const deps = wrapperDeps();
    const viaWrapper = await resolveMintShardWith({ id: "env_1" }, deps);
    const viaCore = computeMintShard(
      { id: "env_1" },
      {
        resolution: { set: ["a", "b"] },
        nowMs: T,
        graceMs: GRACE_MS,
        orgFeatureFlags: undefined,
      }
    );
    expect(viaWrapper).toBe(viaCore);
  });
});

describe("computeMintShard — the global override wins the complete cutover", () => {
  const resolution: MintShardSetResolution = { set: ["a", "b"] };

  it("beats the hash for every environment", () => {
    for (const id of envIds(200)) {
      expect(computeMintShard({ id }, deps(resolution, { globalOverride: "b" }))).toBe("b");
    }
  });

  it("beats a per-org pin", () => {
    const shard = computeMintShard(
      { id: "env_1" },
      deps(resolution, { globalOverride: "b", orgFeatureFlags: { runOpsMintShard: "a" } })
    );
    expect(shard).toBe("b");
  });

  it("beats a per-env pin, which is the whole point of a cutover", () => {
    const shard = computeMintShard(
      { id: "env_1" },
      deps(resolution, {
        globalOverride: "b",
        orgFeatureFlags: { runOpsMintShardEnvPins: JSON.stringify({ env_1: "a" }) },
      })
    );
    expect(shard).toBe("b");
  });

  it("holds the whole fleet on gen-1 when set to new, whatever any org pinned", () => {
    const shard = computeMintShard(
      { id: "env_1" },
      deps(resolution, { globalOverride: "new", orgFeatureFlags: { runOpsMintShard: "a" } })
    );
    expect(shard).toBe("new");
  });

  it("is ignored, and reported, when it names a key outside the active set", () => {
    // Honouring it would mint into a drained or unroutable shard. Explicit pins still apply.
    const rejected: string[] = [];
    const shard = computeMintShard(
      { id: "env_1" },
      deps(resolution, {
        globalOverride: "z",
        orgFeatureFlags: { runOpsMintShard: "a" },
        onOverrideRejected: (info) => rejected.push(info.override),
      })
    );
    expect(shard).toBe("a");
    expect(rejected).toEqual(["z"]);
  });

  it("reports a bad override WITHOUT the environment id, so one line covers the fleet", () => {
    // Keying the report by environment would log once per environment for a fleet-wide setting.
    const seen: Array<{ override: string }> = [];
    for (const id of envIds(50)) {
      computeMintShard(
        { id },
        deps(resolution, { globalOverride: "z", onOverrideRejected: (i) => seen.push(i) })
      );
    }
    expect(seen).toHaveLength(50);
    expect(new Set(seen.map((i) => i.override))).toEqual(new Set(["z"]));
    expect(seen.every((i) => !("environmentId" in i))).toBe(true);
  });

  it("is ignored when it is not a legal value", () => {
    for (const bad of ["legacy", "AB", "", "a,b"]) {
      const shard = computeMintShard({ id: "env_1" }, deps(resolution, { globalOverride: bad }));
      expect(shard).toBe(computeMintShard({ id: "env_1" }, deps(resolution)));
    }
  });

  it("cannot resurrect minting when the list is empty", () => {
    expect(computeMintShard({ id: "env_1" }, deps({ set: [] }, { globalOverride: "b" }))).toBe(
      "new"
    );
  });
});
