import { describe, expect, it, vi } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { MollifierBuffer } from "@trigger.dev/redis-worker";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { runStaleSweepOnce } from "~/v3/mollifier/mollifierStaleSweep.server";
import { MollifierStaleSweepState } from "~/v3/mollifier/mollifierStaleSweepState.server";

const SNAPSHOT = {
  taskIdentifier: "hello-world",
  payload: '{"x":1}',
  payloadType: "application/json",
  traceContext: {},
};

// In-memory fake state for unit tests that don't have a Redis container.
// The testcontainer tests use a real MollifierStaleSweepState against
// the test Redis instead.
function makeFakeState() {
  let cursor = 0;
  let orgList: string[] = [];
  const counts = new Map<string, number>();
  return {
    readCursor: async () => cursor,
    writeCursor: async (v: number) => {
      cursor = v;
    },
    rebuildOrgList: async (orgs: string[]) => {
      orgList = [...orgs];
    },
    readOrgListSlice: async (start: number, count: number) => ({
      orgs: orgList.slice(start, start + count),
      total: orgList.length,
    }),
    setEnvStaleCount: async (envId: string, count: number) => {
      if (count > 0) counts.set(envId, count);
      else counts.delete(envId);
    },
    readAllEnvStaleCounts: async () => new Map(counts),
    clearAll: async () => {
      cursor = 0;
      orgList = [];
      counts.clear();
    },
    close: async () => {},
  };
}

function spyDeps() {
  // Counter ticks — metric carries no `envId` label (high-cardinality)
  // so the spy is a simple call count. Per-env detail lives on the
  // structured warn log and the snapshot map.
  let staleEntryCount = 0;
  const snapshots: Array<Map<string, number>> = [];
  const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
  return {
    get staleEntryCount() {
      return staleEntryCount;
    },
    snapshots,
    warnings,
    deps: {
      recordStaleEntry: () => {
        staleEntryCount += 1;
      },
      reportStaleEntrySnapshot: (snapshot: Map<string, number>) => {
        // Clone so post-sweep assertions see what was reported *at that
        // call site*, not whatever subsequent passes mutate the source
        // map into.
        snapshots.push(new Map(snapshot));
      },
      logger: {
        warn: (message: string, fields: Record<string, unknown>) => {
          warnings.push({ message, fields });
        },
      },
    },
  };
}

describe("runStaleSweepOnce — unit", () => {
  it("returns zeros when the buffer is null", async () => {
    // Mirrors the prod gate: if TRIGGER_MOLLIFIER_ENABLED=0 the buffer
    // singleton is null and the sweep is a no-op. We don't want it to
    // emit a metric (or throw) just because mollifier is disabled.
    const spies = spyDeps();
    const result = await runStaleSweepOnce(
      { staleThresholdMs: 1000 },
      { ...spies.deps, getBuffer: () => null, state: makeFakeState() },
    );
    expect(result).toEqual({
      orgsScanned: 0,
      envsScanned: 0,
      entriesScanned: 0,
      staleCount: 0,
    });
    expect(spies.staleEntryCount).toBe(0);
    expect(spies.warnings).toEqual([]);
    const snapshots = spies.snapshots;
    // An empty snapshot is still reported so any previously-paging env
    // (from a prior sweep before mollifier was disabled) clears.
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].size).toBe(0);
  });
});

describe("runStaleSweepOnce — testcontainers", () => {
  redisTest(
    "flags every entry whose dwell exceeds the stale threshold",
    { timeout: 20_000 },
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions });
      try {
        // Three entries across two envs in the same org. The sweep below
        // runs against a `now` advanced by 5 minutes, so all three have
        // dwell ~5min and ALL THREE are stale against a 1-minute
        // threshold — there is no "fresh" entry in this scenario. The
        // assertions below pin the all-three-stale shape.
        await buffer.accept({
          runId: "run_stale_a",
          envId: "env_a",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT),
        });
        await buffer.accept({
          runId: "run_stale_b",
          envId: "env_b",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT),
        });
        await buffer.accept({
          runId: "run_stale_c",
          envId: "env_a",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT),
        });
        // Yank the system clock forward 5 minutes for the sweep — way
        // past the threshold below. The `now` deps seam lets us drive
        // the threshold without actually waiting in real time.
        const futureNow = Date.now() + 5 * 60 * 1000;

        const spies = spyDeps();
        const state = new MollifierStaleSweepState({ redisOptions });
        try {
          const result = await runStaleSweepOnce(
            { staleThresholdMs: 60 * 1000 },
            {
              ...spies.deps,
              getBuffer: () => buffer,
              state,
              now: () => futureNow,
            },
          );

          expect(result.envsScanned).toBe(2);
          expect(result.entriesScanned).toBe(3);
          expect(result.staleCount).toBe(3);
          // All three entries exceed the threshold; each emits one
          // counter tick + one warning.
          expect(spies.staleEntryCount).toBe(3);
          expect(spies.warnings).toHaveLength(3);
          for (const w of spies.warnings) {
            expect(w.message).toBe("mollifier.stale_entry");
            expect(w.fields.staleThresholdMs).toBe(60 * 1000);
            expect(w.fields.dwellMs).toBeGreaterThan(60 * 1000);
          }
          // Snapshot drives the alertable gauge — env_a has 2 stale
          // entries, env_b has 1. Per-env detail is still passed to
          // `reportStaleEntrySnapshot` for forensic value even though the
          // gauge itself aggregates the total.
          expect(spies.snapshots).toHaveLength(1);
          expect(Object.fromEntries(spies.snapshots[0])).toEqual({
            env_a: 2,
            env_b: 1,
          });
        } finally {
          await state.close();
        }
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "snapshot omits envs that have entries but none stale (durable hash HDEL's zeros)",
    { timeout: 20_000 },
    async ({ redisOptions }) => {
      // Critical for alert behaviour: a previous sweep flagged env_a
      // stale, alert fired, drainer caught up. The next sweep must
      // remove env_a from the durable counts hash so the gauge drops
      // below the alert threshold instead of staying latched at the
      // last stale value. With the sharded design the snapshot is
      // sourced from the HASH directly — visiting an env with zero
      // stale entries HDEL's it, so it's simply absent from the
      // snapshot (telemetry sums values, so absence is equivalent to
      // zero for the gauge).
      const buffer = new MollifierBuffer({ redisOptions });
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        await buffer.accept({
          runId: "run_just_arrived",
          envId: "env_a",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT),
        });
        const spies = spyDeps();
        await runStaleSweepOnce(
          { staleThresholdMs: 60 * 1000 },
          { ...spies.deps, getBuffer: () => buffer, state },
        );
        expect(spies.snapshots).toHaveLength(1);
        // env_a has entries but none stale → not in the snapshot.
        expect(spies.snapshots[0].has("env_a")).toBe(false);
      } finally {
        await state.close();
        await buffer.close();
      }
    },
  );

  redisTest(
    "leaves fresh entries alone (dwell below threshold)",
    { timeout: 20_000 },
    async ({ redisOptions }) => {
      // Regression guard for the inequality direction. A bug that flipped
      // `dwellMs > threshold` to `dwellMs >= threshold` would flag every
      // entry the first time the sweep runs after a perfectly synchronised
      // accept call — the dashboard would page on every burst.
      const buffer = new MollifierBuffer({ redisOptions });
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        await buffer.accept({
          runId: "run_fresh_only",
          envId: "env_a",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT),
        });
        const spies = spyDeps();
        const result = await runStaleSweepOnce(
          { staleThresholdMs: 60 * 1000 },
          { ...spies.deps, getBuffer: () => buffer, state },
        );
        expect(result.staleCount).toBe(0);
        expect(spies.staleEntryCount).toBe(0);
        expect(spies.warnings).toEqual([]);
      } finally {
        await state.close();
        await buffer.close();
      }
    },
  );

  redisTest(
    "shards work across ticks: cursor advances by maxOrgsPerPass and wraps after a full cycle",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      // Without sharding the sweep walks every org/env every tick — at
      // any meaningful backlog that runs longer than the tick interval
      // and the next tick gets dropped by the inFlight guard. Sharding
      // splits the work: each tick visits at most `maxOrgsPerPass` orgs,
      // advances a durable cursor, and resumes from there next tick.
      // Over `ceil(N / cap)` ticks the cycle covers every org.
      const buffer = new MollifierBuffer({ redisOptions });
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        for (let i = 0; i < 5; i++) {
          await buffer.accept({
            runId: `run_shard_${i}`,
            envId: `env_shard_${i}`,
            orgId: `org_shard_${i}`,
            payload: JSON.stringify(SNAPSHOT),
          });
        }
        const futureNow = Date.now() + 5 * 60 * 1000;
        const spies = spyDeps();
        const cfg = { staleThresholdMs: 60 * 1000, maxOrgsPerPass: 2 };
        const baseDeps = {
          ...spies.deps,
          getBuffer: () => buffer,
          state,
          now: () => futureNow,
        };

        // Tick 1: cursor starts at 0, scans 2 orgs.
        const r1 = await runStaleSweepOnce(cfg, baseDeps);
        expect(r1.orgsScanned).toBe(2);
        expect(spies.snapshots[0].size).toBe(2);

        // Tick 2: cursor was 2, scans 2 more orgs.
        const r2 = await runStaleSweepOnce(cfg, baseDeps);
        expect(r2.orgsScanned).toBe(2);
        // Snapshot is the durable HASH — accumulates across ticks.
        expect(spies.snapshots[1].size).toBe(4);

        // Tick 3: cursor was 4, scans the last 1 org and wraps to 0.
        const r3 = await runStaleSweepOnce(cfg, baseDeps);
        expect(r3.orgsScanned).toBe(1);
        expect(spies.snapshots[2].size).toBe(5);

        // Tick 4: cycle complete, cursor is back at 0 — starts over.
        const r4 = await runStaleSweepOnce(cfg, baseDeps);
        expect(r4.orgsScanned).toBe(2);
      } finally {
        await state.close();
        await buffer.close();
      }
    },
  );

  redisTest(
    "clears an env from the durable snapshot on revisit when it has entries but none currently stale",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      // Stale state in the durable hash must be HDEL'd, not just left
      // stale, when a previously-flagged env no longer has any entries
      // whose dwell exceeds the threshold (drainer caught up, alert
      // condition cleared). The same `entry` flips from stale to
      // not-stale between two sweep ticks by varying the sweep's `now`
      // — tick 1 uses a future clock so the entry is flagged stale;
      // tick 2 uses real time so the same entry has near-zero dwell and
      // is no longer stale. The env stays in the active set throughout
      // (queue still has an entry), so the cursor revisits it and the
      // hash field is cleared.
      const buffer = new MollifierBuffer({ redisOptions });
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        await buffer.accept({
          runId: "run_drain",
          envId: "env_drain",
          orgId: "org_drain",
          payload: JSON.stringify(SNAPSHOT),
        });
        const futureNow = Date.now() + 5 * 60 * 1000;
        const spies = spyDeps();
        const cfg = { staleThresholdMs: 60 * 1000, maxOrgsPerPass: 10 };

        // Tick 1 with future clock: entry's dwell is 5min vs 1min
        // threshold → flagged stale.
        await runStaleSweepOnce(cfg, {
          ...spies.deps,
          getBuffer: () => buffer,
          state,
          now: () => futureNow,
        });
        expect(spies.snapshots[0].get("env_drain")).toBe(1);

        // Tick 2 with real time: same entry, but its dwell is now ~ms
        // vs the same 1min threshold → not stale. The env is revisited
        // (cursor wrapped to 0 after tick 1, only 1 org in the list),
        // setEnvStaleCount called with 0 → HDEL.
        await runStaleSweepOnce(cfg, {
          ...spies.deps,
          getBuffer: () => buffer,
          state,
        });
        expect(spies.snapshots[1].has("env_drain")).toBe(false);
      } finally {
        await state.close();
        await buffer.close();
      }
    },
  );

  redisTest(
    "scans across multiple orgs",
    { timeout: 20_000 },
    async ({ redisOptions }) => {
      // The drainer pops with org-level fairness, so the sweep must
      // walk every org/env to surface stale entries across all of them
      // — not just stop at the first env it finds. If a future refactor
      // collapsed listOrgs/listEnvsForOrg into a single env-flat list,
      // this test catches a regression there.
      const buffer = new MollifierBuffer({ redisOptions });
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        await buffer.accept({
          runId: "run_x",
          envId: "env_x",
          orgId: "org_x",
          payload: JSON.stringify(SNAPSHOT),
        });
        await buffer.accept({
          runId: "run_y",
          envId: "env_y",
          orgId: "org_y",
          payload: JSON.stringify(SNAPSHOT),
        });
        const futureNow = Date.now() + 5 * 60 * 1000;
        const spies = spyDeps();
        const result = await runStaleSweepOnce(
          { staleThresholdMs: 60 * 1000 },
          { ...spies.deps, getBuffer: () => buffer, state, now: () => futureNow },
        );
        expect(result.orgsScanned).toBe(2);
        expect(result.envsScanned).toBe(2);
        expect(result.staleCount).toBe(2);
      } finally {
        await state.close();
        await buffer.close();
      }
    },
  );
});
