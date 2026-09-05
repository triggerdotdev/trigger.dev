// `off` is a rollout position, not a kill switch: refusing a resident run's transitions freezes its
// Redis head while Postgres advances, which is the mid-life store switch residency forbids. So
// `off` stops new residency only, and the halt switch is the hard stop. Pure predicates, no
// containers.
import { describe, expect, it } from "vitest";
import { TaskRunExecutionSnapshotStore } from "./taskRunExecutionSnapshotStore.js";
import type {
  SnapshotStoreMode,
  SnapshotStoreModeResolver,
} from "./taskRunExecutionSnapshotStore.js";
import type { RedisSnapshotStore } from "./redisSnapshotStore.js";
import type { RunStore } from "./types.js";

type CohortProbe = { readsFromRedis(runId: string): boolean };

// Only the in-process regime accessors the read/write predicates consult; no I/O members, because
// these predicate tests never mirror or read through Redis.
const regimeOnlyRedis = {
  regimeFor: () => undefined,
  recordRegime: () => {},
} as unknown as RedisSnapshotStore;

function storeWith(options: {
  mode: SnapshotStoreMode;
  resolver?: SnapshotStoreModeResolver;
  halted?: boolean;
}) {
  return new TaskRunExecutionSnapshotStore({} as unknown as RunStore, {
    store: regimeOnlyRedis,
    mode: options.mode,
    ...(options.resolver && { modeResolver: options.resolver }),
    ...(options.halted !== undefined && { halted: () => options.halted === true }),
  });
}

describe("a global dial-down to off", () => {
  it("keeps a resident run's transitions mirroring", () => {
    const s = storeWith({ mode: "off" });
    expect(s.writesRedisForTransitionTest()).toBe(true);
  });

  it("stops new births", () => {
    const s = storeWith({ mode: "off" });
    expect(s.writesRedisForBirthTest("org_1")).toBe(false);
    expect(s.writesRedisForBirthTest(undefined)).toBe(false);
  });
});

describe("the halt switch", () => {
  it("stops births and transitions at every dial position", () => {
    for (const mode of ["off", "dual-write", "redis-read", "redis-only"] as const) {
      const s = storeWith({ mode, halted: true });
      expect(s.writesRedisForBirthTest("org_1")).toBe(false);
      expect(s.writesRedisForTransitionTest()).toBe(false);
    }
  });

  it("leaves births and transitions alone when it is not thrown", () => {
    const s = storeWith({ mode: "dual-write", halted: false });
    expect(s.writesRedisForBirthTest("org_1")).toBe(true);
    expect(s.writesRedisForTransitionTest()).toBe(true);
  });

  it("sends redis-read reads back to Postgres, which is still authoritative there", () => {
    const s = storeWith({ mode: "redis-read", halted: true }) as unknown as CohortProbe;
    expect(s.readsFromRedis("run_halted")).toBe(false);
  });

  it("leaves redis-only reads on Redis, which holds the only copy", () => {
    // Routing these to Postgres reads nothing at all: at this position Postgres holds no snapshot
    // rows. A halt here is a resync, not a fallback.
    const s = storeWith({ mode: "redis-only", halted: true }) as unknown as CohortProbe;
    expect(s.readsFromRedis("run_halted")).toBe(true);
  });
});
