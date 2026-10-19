import { describe, expect, it } from "vitest";
import {
  computeMintShard,
  resolveMintShardWith,
  type MintShardCache,
  type MintShardDeps,
  type ResolveMintShardDeps,
} from "./mintShardAssignment";
import { type MintShardSetResolution } from "./mintShardGrace";

const GRACE_MS = 90_000;
const T = 1_000_000;

// Cuid-shaped ids, so "nobody unpinned moves" is checked over a realistic id space rather than
// one environment.
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

describe("computeMintShard — the no-shards answer", () => {
  it("returns new when the live list is empty", () => {
    expect(computeMintShard({ id: "env_1" }, deps({ set: [] }))).toBe("new");
  });

  it("returns new when a stale stamp is present but both lists are empty", () => {
    const resolution: MintShardSetResolution = { set: [], prevSet: [], flippedAtMs: T };
    expect(computeMintShard({ id: "env_1" }, deps(resolution, { nowMs: T + 1 }))).toBe("new");
  });

  it("returns new when the grace serves an empty prevSet", () => {
    const resolution: MintShardSetResolution = { set: ["a"], prevSet: [], flippedAtMs: T };
    expect(computeMintShard({ id: "env_1" }, deps(resolution, { nowMs: T + 1 }))).toBe("new");
  });

  it("is gated by the active set: an empty set mints gen-1 whatever the pin", () => {
    expect(
      computeMintShard({ id: "env_1" }, deps({ set: [] }, orgFlags({ runOpsMintShard: "a" })))
    ).toBe("new");
    expect(
      computeMintShard(
        { id: "env_1" },
        deps({ set: [] }, orgFlags({ runOpsMintShardEnvPins: JSON.stringify({ env_1: "a" }) }))
      )
    ).toBe("new");
  });
});

describe("computeMintShard — unpinned environments never move", () => {
  it("mints gen-1 for an unpinned environment while the active set is live", () => {
    expect(computeMintShard({ id: "env_1" }, deps({ set: ["a"] }))).toBe("new");
  });

  it("mints gen-1 for every unpinned environment across two active keys (no spreading)", () => {
    for (const id of envIds(1_000)) {
      expect(computeMintShard({ id }, deps({ set: ["a", "b"] }))).toBe("new");
    }
  });

  it("keeps unpinned environments on gen-1 when a shard is added to the set", () => {
    for (const id of envIds(200)) {
      expect(computeMintShard({ id }, deps({ set: ["a", "b", "c"] }))).toBe("new");
    }
  });
});

describe("computeMintShard — pins", () => {
  const resolution: MintShardSetResolution = { set: ["a", "b"] };

  it("mints on the org pin when the key is in the active set", () => {
    for (const id of envIds(50)) {
      expect(computeMintShard({ id }, deps(resolution, orgFlags({ runOpsMintShard: "a" })))).toBe(
        "a"
      );
    }
  });

  it("mints on the env pin when the key is in the active set", () => {
    expect(
      computeMintShard(
        { id: "env_1" },
        deps(resolution, orgFlags({ runOpsMintShardEnvPins: JSON.stringify({ env_1: "b" }) }))
      )
    ).toBe("b");
  });

  it("applies an env pin only to the environment it names", () => {
    const flags = orgFlags({ runOpsMintShardEnvPins: JSON.stringify({ env_1: "b" }) });
    expect(computeMintShard({ id: "env_2" }, deps(resolution, flags))).toBe("new");
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

  it("holds an environment on gen-1 when the env pin is new, even under an org pin key", () => {
    const result = computeMintShard(
      { id: "env_1" },
      deps(
        resolution,
        orgFlags({
          runOpsMintShard: "a",
          runOpsMintShardEnvPins: JSON.stringify({ env_1: "new" }),
        })
      )
    );
    expect(result).toBe("new");
  });

  it("holds an environment on gen-1 when the org pin is new", () => {
    expect(
      computeMintShard({ id: "env_1" }, deps(resolution, orgFlags({ runOpsMintShard: "new" })))
    ).toBe("new");
  });

  it("mints gen-1 and reports when the pin is outside the active set", () => {
    // Honouring a drained pin would leak the drain; throwing would fail customer triggers.
    const rejected: Array<{ environmentId: string; pin: string; activeSet: string[] }> = [];
    const result = computeMintShard(
      { id: "env_1" },
      deps(resolution, {
        ...orgFlags({ runOpsMintShard: "z" }),
        onPinRejected: (info) => rejected.push(info),
      })
    );
    expect(result).toBe("new");
    expect(rejected).toEqual([{ environmentId: "env_1", pin: "z", activeSet: ["a", "b"] }]);
  });

  it("reports an env pin outside the active set the same way", () => {
    const rejected: string[] = [];
    const result = computeMintShard(
      { id: "env_1" },
      deps(resolution, {
        ...orgFlags({ runOpsMintShardEnvPins: JSON.stringify({ env_1: "z" }) }),
        onPinRejected: (info) => rejected.push(info.pin),
      })
    );
    expect(result).toBe("new");
    expect(rejected).toEqual(["z"]);
  });

  it("honours a pin to a drained key for the whole grace window, then mints gen-1", () => {
    const draining: MintShardSetResolution = { set: ["a"], prevSet: ["a", "b"], flippedAtMs: T };
    const pinnedToB = orgFlags({ runOpsMintShard: "b" });
    expect(computeMintShard({ id: "env_1" }, deps(draining, { ...pinnedToB, nowMs: T + 1 }))).toBe(
      "b"
    );
    expect(
      computeMintShard({ id: "env_1" }, deps(draining, { ...pinnedToB, nowMs: T + GRACE_MS }))
    ).toBe("new");
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

  it("treats an invalid org pin value as no pin", () => {
    const rejected: string[] = [];
    const result = computeMintShard(
      { id: "env_1" },
      deps(resolution, {
        ...orgFlags({ runOpsMintShard: "legacy" }),
        onPinRejected: (info) => rejected.push(info.pin),
      })
    );
    expect(result).toBe("new");
    expect(rejected).toEqual([]);
  });
});

describe("resolveMintShardWith — cache, read failure and fail-safe", () => {
  // Pinned to "b" by default, so a successful read is distinguishable from the gen-1 fail-safe.
  function wrapperDeps(
    overrides: Partial<ResolveMintShardDeps> = {}
  ): ResolveMintShardDeps & { reads: number } {
    const state = {
      readFlags: async () => ({ runOpsMintShardSet: "a,b" }),
      cache: { current: undefined as MintShardCache },
      nowMs: T,
      ttlMs: 30_000,
      graceMs: GRACE_MS,
      orgFeatureFlags: { runOpsMintShard: "b" } as unknown,
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

  it("mints on the pin, and gen-1 for an unpinned environment, from ONE read", async () => {
    const pinned = wrapperDeps();
    expect(await resolveMintShardWith({ id: "env_1" }, pinned)).toBe("b");

    const unpinned = wrapperDeps({ orgFeatureFlags: undefined, cache: pinned.cache });
    expect(await resolveMintShardWith({ id: "env_2" }, unpinned)).toBe("new");
    expect(pinned.reads + unpinned.reads).toBe(1);
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
    expect(await resolveMintShardWith({ id: "env_1" }, deps)).toBe("b");
  });

  it("reports an unparseable stored list while still degrading to gen-1", async () => {
    // The observed failure: `runOpsMintShardSet` saved as "A,B" (uppercase) reverted the whole
    // fleet to gen-1 minting with ZERO log lines, because the parse throw was swallowed and
    // `onReadFailed` never fires for it — the read succeeded. The degrade is correct; silence is not.
    const deps = wrapperDeps({ readFlags: async () => ({ runOpsMintShardSet: "A,B" }) });
    const readFailures: unknown[] = [];
    const parseFailures: Array<{ key: string; value: string }> = [];
    deps.onReadFailed = (error) => readFailures.push(error);
    deps.onSetParseFailed = ({ key, value }) => parseFailures.push({ key, value });

    expect(await resolveMintShardWith({ id: "env_1" }, deps)).toBe("new");
    expect(readFailures).toEqual([]);
    expect(parseFailures).toEqual([{ key: "runOpsMintShardSet", value: "A,B" }]);
  });

  it("reports a reserved key in the stored list too", async () => {
    const deps = wrapperDeps({ readFlags: async () => ({ runOpsMintShardSet: "a,legacy" }) });
    const parseFailures: Array<{ key: string; value: string }> = [];
    deps.onSetParseFailed = ({ key, value }) => parseFailures.push({ key, value });

    expect(await resolveMintShardWith({ id: "env_1" }, deps)).toBe("new");
    expect(parseFailures).toEqual([{ key: "runOpsMintShardSet", value: "a,legacy" }]);
  });

  it("stays silent for a stored list that parses", async () => {
    const deps = wrapperDeps();
    const parseFailures: unknown[] = [];
    deps.onSetParseFailed = (failure) => parseFailures.push(failure);

    expect(await resolveMintShardWith({ id: "env_1" }, deps)).toBe("b");
    expect(parseFailures).toEqual([]);
  });

  it("returns gen-1 when the stored list is empty", async () => {
    const deps = wrapperDeps({ readFlags: async () => ({ runOpsMintShardSet: "" }) });
    expect(await resolveMintShardWith({ id: "env_1" }, deps)).toBe("new");
  });

  it("coalesces concurrent misses into ONE read", async () => {
    // Two misses must share a single read. Otherwise a slower read landing after a faster one
    // writes its older snapshot back into the cache for a whole TTL.
    let release: (flags: Record<string, unknown>) => void = () => {};
    const gate = new Promise<Record<string, unknown>>((resolve) => {
      release = resolve;
    });
    const deps = wrapperDeps({ readFlags: () => gate });

    const both = Promise.all([
      resolveMintShardWith({ id: "env_1" }, deps),
      resolveMintShardWith({ id: "env_2" }, deps),
    ]);
    release({ runOpsMintShardSet: "a,b" });
    await both;

    expect(deps.reads).toBe(1);
  });

  it("does not let a slower read overwrite a newer one", async () => {
    // The slow read starts first and finishes last. Its result must not become the cached
    // value, because the fast read already published a newer snapshot.
    let releaseSlow: (flags: Record<string, unknown>) => void = () => {};
    const slow = new Promise<Record<string, unknown>>((resolve) => {
      releaseSlow = resolve;
    });
    let call = 0;
    const deps = wrapperDeps({
      readFlags: () => {
        call++;
        return call === 1 ? slow : Promise.resolve({ runOpsMintShardSet: "c" });
      },
    });

    const first = resolveMintShardWith({ id: "env_1" }, deps);
    const second = resolveMintShardWith({ id: "env_2" }, deps);
    releaseSlow({ runOpsMintShardSet: "a" });
    await Promise.all([first, second]);

    // One read served both, so there is no second snapshot to race with.
    expect(deps.reads).toBe(1);
    expect(deps.cache.current?.value.resolution.set).toEqual(["a"]);
  });

  it("clears the in-flight refresh after a failure, so the next call retries", async () => {
    let fail = true;
    const deps = wrapperDeps({
      readFlags: async () => {
        if (fail) throw new Error("db down");
        return { runOpsMintShardSet: "a,b" };
      },
    });
    deps.onReadFailed = () => {};

    expect(await resolveMintShardWith({ id: "env_1" }, deps)).toBe("new");
    fail = false;
    expect(await resolveMintShardWith({ id: "env_1" }, deps)).toBe("b");
    expect(deps.reads).toBe(2);
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
        orgFeatureFlags: { runOpsMintShard: "b" },
      }
    );
    expect(viaWrapper).toBe("b");
    expect(viaWrapper).toBe(viaCore);
  });
});

describe("computeMintShard — the global override wins the complete cutover", () => {
  const resolution: MintShardSetResolution = { set: ["a", "b"] };

  it("sends every unpinned environment to the override key", () => {
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

  it("beats a pin to new, at org and at env level", () => {
    expect(
      computeMintShard(
        { id: "env_1" },
        deps(resolution, { globalOverride: "a", orgFeatureFlags: { runOpsMintShard: "new" } })
      )
    ).toBe("a");
    expect(
      computeMintShard(
        { id: "env_1" },
        deps(resolution, {
          globalOverride: "a",
          orgFeatureFlags: { runOpsMintShardEnvPins: JSON.stringify({ env_1: "new" }) },
        })
      )
    ).toBe("a");
  });

  it("holds the whole fleet on gen-1 when set to new, whatever any org pinned", () => {
    const shard = computeMintShard(
      { id: "env_1" },
      deps(resolution, { globalOverride: "new", orgFeatureFlags: { runOpsMintShard: "a" } })
    );
    expect(shard).toBe("new");
    expect(computeMintShard({ id: "env_2" }, deps(resolution, { globalOverride: "new" }))).toBe(
      "new"
    );
  });

  it("hands placement back to the pins when it is cleared: a pinned org stays on its shard, an unpinned org returns to gen-1", () => {
    // The capacity story: shard a fills, the override sent everyone there, then shard b is added
    // and the override moves to b. An org pinned to a keeps minting on a, and clearing the
    // override does not shuffle anybody who was never pinned.
    const pinnedToA = { runOpsMintShard: "a" };
    expect(
      computeMintShard(
        { id: "env_1" },
        deps(resolution, { globalOverride: "a", orgFeatureFlags: pinnedToA })
      )
    ).toBe("a");
    expect(computeMintShard({ id: "env_2" }, deps(resolution, { globalOverride: "a" }))).toBe("a");

    expect(
      computeMintShard(
        { id: "env_1" },
        deps(resolution, { globalOverride: "b", orgFeatureFlags: pinnedToA })
      )
    ).toBe("b");
    expect(computeMintShard({ id: "env_2" }, deps(resolution, { globalOverride: "b" }))).toBe("b");

    expect(
      computeMintShard({ id: "env_1" }, deps(resolution, { orgFeatureFlags: pinnedToA }))
    ).toBe("a");
    expect(computeMintShard({ id: "env_2" }, deps(resolution, {}))).toBe("new");
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

  it("leaves an unpinned environment on gen-1 when it is ignored", () => {
    expect(computeMintShard({ id: "env_1" }, deps(resolution, { globalOverride: "z" }))).toBe(
      "new"
    );
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
      const shard = computeMintShard(
        { id: "env_1" },
        deps(resolution, { globalOverride: bad, ...orgFlags({ runOpsMintShard: "a" }) })
      );
      expect(shard).toBe("a");
    }
  });

  it("cannot resurrect minting when the list is empty", () => {
    expect(computeMintShard({ id: "env_1" }, deps({ set: [] }, { globalOverride: "b" }))).toBe(
      "new"
    );
  });
});

describe("routableKeys bound (the shard descriptor keys this deployment can route)", () => {
  it("honours a pin to an active key that is routable", () => {
    const shard = computeMintShard(
      { id: "env_1" },
      deps({ set: ["a", "z"] }, { ...orgFlags({ runOpsMintShard: "a" }), routableKeys: ["a"] })
    );
    expect(shard).toBe("a");
  });

  it("returns new when the active list holds only non-routable keys (fail-safe to gen-1)", () => {
    expect(
      computeMintShard(
        { id: "env_1" },
        deps({ set: ["z"] }, { ...orgFlags({ runOpsMintShard: "z" }), routableKeys: ["a"] })
      )
    ).toBe("new");
  });

  it("rejects a pin to an active but non-routable key, mints gen-1 and reports it", () => {
    const rejected: Array<{ pin: string; activeSet: string[] }> = [];
    const shard = computeMintShard(
      { id: "env_1" },
      deps(
        { set: ["a", "z"] },
        {
          ...orgFlags({ runOpsMintShard: "z" }),
          routableKeys: ["a"],
          onPinRejected: ({ pin, activeSet }) => rejected.push({ pin, activeSet }),
        }
      )
    );
    expect(shard).toBe("new");
    expect(rejected).toEqual([{ pin: "z", activeSet: ["a"] }]);
  });

  it("ignores an override to a non-routable key", () => {
    const shard = computeMintShard(
      { id: "env_1" },
      deps({ set: ["a", "z"] }, { globalOverride: "z", routableKeys: ["a"] })
    );
    expect(shard).toBe("new");
  });
});
