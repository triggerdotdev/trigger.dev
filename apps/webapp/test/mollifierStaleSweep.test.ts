import { describe, expect, it, vi } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { MollifierBuffer } from "@trigger.dev/redis-worker";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import {
  runStaleSweepOnce,
  startStaleSweepInterval,
} from "~/v3/mollifier/mollifierStaleSweep.server";
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
  let visited = new Set<string>();
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
    markEnvVisited: async (envId: string) => {
      visited.add(envId);
    },
    reconcileVisited: async () => {
      for (const envId of [...counts.keys()]) {
        if (!visited.has(envId)) counts.delete(envId);
      }
      visited = new Set();
    },
    clearAll: async () => {
      cursor = 0;
      orgList = [];
      counts.clear();
      visited = new Set();
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
      { ...spies.deps, getBuffer: () => null, state: makeFakeState() }
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

  it("surfaces readOrgListSlice failures and leaves durable state untouched", async () => {
    // Regression: previously a Redis read failure inside
    // `readOrgListSlice` returned `{ orgs: [], total: 0 }` and the
    // sweep treated that as a clean empty cycle — writing cursor=0,
    // reconciling visited envs against the empty result, and CLEARING
    // the stale-entry gauge. That silenced the very alerts the sweep
    // exists to raise. The fix re-throws; the caller (this function
    // and the interval wrapper above it) must NOT mutate cursor or
    // counts when readOrgListSlice fails.
    const state = makeFakeState();
    // Seed durable state so we can assert it isn't touched on failure.
    await state.writeCursor(42);
    await state.setEnvStaleCount("env_seed", 7);
    await state.rebuildOrgList(["org_pre"]);
    // Inject a failure on the very next slice read.
    const readErr = new Error("Redis read failed");
    let readAttempts = 0;
    const failingState = {
      ...state,
      readOrgListSlice: async (_start: number, _count: number) => {
        readAttempts += 1;
        throw readErr;
      },
    };
    const spies = spyDeps();
    const buffer = {
      listOrgs: async () => ["org_pre"],
      listEnvsForOrg: async () => [],
      listEntriesForEnv: async () => [],
    } as unknown as MollifierBuffer;

    await expect(
      runStaleSweepOnce(
        { staleThresholdMs: 60_000, maxOrgsPerPass: 10 },
        {
          ...spies.deps,
          state: failingState,
          getBuffer: () => buffer,
          now: () => Date.now(),
        }
      )
    ).rejects.toThrow("Redis read failed");

    expect(readAttempts).toBe(1);
    // Cursor untouched (still the seeded 42, not reset to 0).
    expect(await state.readCursor()).toBe(42);
    // Counts hash untouched — the seeded env's count survives the
    // failed cycle so the gauge keeps reporting its last-known value.
    const counts = await state.readAllEnvStaleCounts();
    expect(counts.get("env_seed")).toBe(7);
    // No snapshot was reported because the function threw before
    // reaching reportStaleEntrySnapshot.
    expect(spies.snapshots).toHaveLength(0);
    expect(spies.staleEntryCount).toBe(0);
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
            }
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
    }
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
          { ...spies.deps, getBuffer: () => buffer, state }
        );
        expect(spies.snapshots).toHaveLength(1);
        // env_a has entries but none stale → not in the snapshot.
        expect(spies.snapshots[0].has("env_a")).toBe(false);
      } finally {
        await state.close();
        await buffer.close();
      }
    }
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
          { ...spies.deps, getBuffer: () => buffer, state }
        );
        expect(result.staleCount).toBe(0);
        expect(spies.staleEntryCount).toBe(0);
        expect(spies.warnings).toEqual([]);
      } finally {
        await state.close();
        await buffer.close();
      }
    }
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
    }
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
    }
  );

  redisTest(
    "evicts fully-drained envs from the counts hash at cycle wrap (no permanent alert)",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      // Devin's BUG report on PR #3754: an env that drains completely
      // between sweep ticks disappears from `mollifier:org-envs:${orgId}`
      // entirely, so the inner loop at runStaleSweepOnce never visits it
      // and `setEnvStaleCount(envId, 0)` (which HDELs the field) is
      // never called. The counts hash retains the env's last-known
      // stale count forever, the gauge stays elevated, and the
      // recommended alert `> 0 for 5m` fires indefinitely.
      //
      // Fix: at cycle wrap (cursor returned to 0) HDEL any env in the
      // counts hash that wasn't visited during the just-completed cycle.
      // Verified here by:
      //   1. Flagging env_will_drain stale, confirming it's in the hash
      //   2. Draining its only entry — now invisible to listEnvsForOrg
      //   3. Running a sweep tick that triggers cycle wrap
      //   4. Asserting the env is no longer in the snapshot
      const buffer = new MollifierBuffer({ redisOptions });
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        await buffer.accept({
          runId: "run_will_drain",
          envId: "env_will_drain",
          orgId: "org_will_drain",
          payload: JSON.stringify(SNAPSHOT),
        });
        const futureNow = Date.now() + 5 * 60 * 1000;
        const cfg = { staleThresholdMs: 60 * 1000, maxOrgsPerPass: 10 };
        const spies = spyDeps();

        // Tick 1: env_will_drain is flagged stale → enters counts hash.
        // Cursor wraps to 0 (only 1 org in the list).
        await runStaleSweepOnce(cfg, {
          ...spies.deps,
          getBuffer: () => buffer,
          state,
          now: () => futureNow,
        });
        expect(spies.snapshots[0].get("env_will_drain")).toBe(1);

        // Drain the only entry. mollifier:queue:env_will_drain is now
        // empty, and the buffer's atomic Lua removes env_will_drain
        // from `mollifier:org-envs:org_will_drain` (and removes the org
        // from `mollifier:orgs` since it has no other envs). The env is
        // now invisible to listEnvsForOrg.
        const popped = await buffer.pop("env_will_drain");
        expect(popped?.runId).toBe("run_will_drain");

        // Tick 2: cursor was 0 after tick 1's wrap, so this rebuilds
        // the org list (now empty) and immediately wraps again. The
        // wrap-handler must HDEL env_will_drain from the counts hash
        // because it wasn't in the visited set for this cycle.
        await runStaleSweepOnce(cfg, {
          ...spies.deps,
          getBuffer: () => buffer,
          state,
          now: () => futureNow,
        });
        expect(spies.snapshots[1].has("env_will_drain")).toBe(false);
        // And the durable hash is genuinely empty, not just absent from
        // this snapshot.
        expect((await state.readAllEnvStaleCounts()).size).toBe(0);
      } finally {
        await state.close();
        await buffer.close();
      }
    }
  );

  redisTest("scans across multiple orgs", { timeout: 20_000 }, async ({ redisOptions }) => {
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
        { ...spies.deps, getBuffer: () => buffer, state, now: () => futureNow }
      );
      expect(result.orgsScanned).toBe(2);
      expect(result.envsScanned).toBe(2);
      expect(result.staleCount).toBe(2);
    } finally {
      await state.close();
      await buffer.close();
    }
  });

  redisTest(
    "state survives process restart: a second state instance picks up the cursor and counts",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      // This is the headline reason the sweep state is durable in Redis
      // instead of process-local — a webapp restart mid-cycle must not
      // re-emit the gauge as fresh-zero for previously-flagged envs nor
      // restart the cursor walk from scratch. Simulated here by closing
      // state1 (its Redis client quits cleanly) and constructing state2
      // against the same Redis. The cursor + counts that state1 wrote
      // are visible to state2 on its first tick.
      const buffer = new MollifierBuffer({ redisOptions });
      const state1 = new MollifierStaleSweepState({ redisOptions });
      try {
        await buffer.accept({
          runId: "run_a",
          envId: "env_a",
          orgId: "org_a",
          payload: JSON.stringify(SNAPSHOT),
        });
        await buffer.accept({
          runId: "run_b",
          envId: "env_b",
          orgId: "org_b",
          payload: JSON.stringify(SNAPSHOT),
        });
        const futureNow = Date.now() + 5 * 60 * 1000;
        const cfg = { staleThresholdMs: 60 * 1000, maxOrgsPerPass: 1 };
        const spies1 = spyDeps();

        // Tick 1 with state1: visits 1 of 2 orgs.
        await runStaleSweepOnce(cfg, {
          ...spies1.deps,
          getBuffer: () => buffer,
          state: state1,
          now: () => futureNow,
        });
        expect(spies1.snapshots[0].size).toBe(1);
      } finally {
        // Simulate webapp restart: state1's Redis client closes cleanly.
        await state1.close();
      }

      // New process boots, constructs a fresh state pointing at the
      // same Redis. The cycle's frozen org_list, the cursor, and the
      // counts hash are all preserved — state2 picks up at the second
      // org of the cycle.
      const state2 = new MollifierStaleSweepState({ redisOptions });
      try {
        const futureNow = Date.now() + 5 * 60 * 1000;
        const cfg = { staleThresholdMs: 60 * 1000, maxOrgsPerPass: 1 };
        const spies2 = spyDeps();

        await runStaleSweepOnce(cfg, {
          ...spies2.deps,
          getBuffer: () => buffer,
          state: state2,
          now: () => futureNow,
        });
        // Snapshot now has BOTH envs: the one tick 1 flagged (still in
        // the counts hash from state1) plus the one tick 2 just flagged.
        // A non-durable design would show only the second.
        expect(spies2.snapshots[0].size).toBe(2);
      } finally {
        await state2.close();
        await buffer.close();
      }
    }
  );

  redisTest(
    "cycle wrap rebuilds the org list, so orgs that joined mid-cycle get visited on the next cycle",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      // The docstring promises "orgs joining mid-cycle wait until the
      // next cycle to be visited." The mechanism is rebuildOrgList at
      // cursor=0: a fresh snapshot of buffer.listOrgs() replaces the
      // previous frozen LIST. Verified here by adding a third org
      // between cycles and asserting it shows up only in the next
      // cycle's snapshot.
      const buffer = new MollifierBuffer({ redisOptions });
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        await buffer.accept({
          runId: "run_init_a",
          envId: "env_init_a",
          orgId: "org_init_a",
          payload: JSON.stringify(SNAPSHOT),
        });
        await buffer.accept({
          runId: "run_init_b",
          envId: "env_init_b",
          orgId: "org_init_b",
          payload: JSON.stringify(SNAPSHOT),
        });
        const futureNow = Date.now() + 5 * 60 * 1000;
        const spies = spyDeps();
        const cfg = { staleThresholdMs: 60 * 1000, maxOrgsPerPass: 10 };
        const baseDeps = {
          ...spies.deps,
          getBuffer: () => buffer,
          state,
          now: () => futureNow,
        };

        // Tick 1: cycle 1. Visits both initial orgs; cursor wraps to 0.
        await runStaleSweepOnce(cfg, baseDeps);
        expect(spies.snapshots[0].size).toBe(2);

        // Mid-flight: a third org joins the buffer. It must NOT have
        // been part of cycle 1's frozen LIST.
        await buffer.accept({
          runId: "run_mid",
          envId: "env_mid",
          orgId: "org_mid",
          payload: JSON.stringify(SNAPSHOT),
        });

        // Tick 2: cycle 2 begins (cursor was 0 after tick 1's wrap).
        // rebuildOrgList captures all 3 orgs; this tick visits all 3.
        const r2 = await runStaleSweepOnce(cfg, baseDeps);
        expect(r2.orgsScanned).toBe(3);
        expect(spies.snapshots[1].size).toBe(3);
        expect(spies.snapshots[1].has("env_mid")).toBe(true);
      } finally {
        await state.close();
        await buffer.close();
      }
    }
  );

  redisTest(
    "empty buffer (no orgs) advances cleanly with zero work and an empty snapshot",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      // `mollifier:orgs` is empty (no entries ever accepted, or every
      // entry has been drained). The sweep must handle the boundary:
      // rebuildOrgList with [], readOrgListSlice returns total=0,
      // the org loop is skipped, and the cursor stays at 0 instead of
      // tripping the wrap math.
      const buffer = new MollifierBuffer({ redisOptions });
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        const spies = spyDeps();
        const result = await runStaleSweepOnce(
          { staleThresholdMs: 60 * 1000, maxOrgsPerPass: 10 },
          { ...spies.deps, getBuffer: () => buffer, state }
        );
        expect(result).toEqual({
          orgsScanned: 0,
          envsScanned: 0,
          entriesScanned: 0,
          staleCount: 0,
        });
        expect(spies.snapshots).toHaveLength(1);
        expect(spies.snapshots[0].size).toBe(0);
        // Cursor stayed at 0 — nothing to advance through.
        expect(await state.readCursor()).toBe(0);
      } finally {
        await state.close();
        await buffer.close();
      }
    }
  );

  redisTest(
    "buffer-null branch wipes the durable state so a re-enable starts fresh",
    { timeout: 30_000 },
    async ({ redisOptions }) => {
      // The unit test above asserts the snapshot is empty when the
      // buffer is null, but doesn't verify the durable state was
      // actually cleared. Without clearAll the next re-enable would
      // resume on a stale cursor + carry over a stale counts hash.
      const buffer = new MollifierBuffer({ redisOptions });
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        await buffer.accept({
          runId: "run_seed",
          envId: "env_seed",
          orgId: "org_seed",
          payload: JSON.stringify(SNAPSHOT),
        });
        const futureNow = Date.now() + 5 * 60 * 1000;
        const cfg = { staleThresholdMs: 60 * 1000, maxOrgsPerPass: 10 };
        const spies = spyDeps();

        // Tick 1: populate state.
        await runStaleSweepOnce(cfg, {
          ...spies.deps,
          getBuffer: () => buffer,
          state,
          now: () => futureNow,
        });
        expect(spies.snapshots[0].size).toBe(1);
        expect((await state.readAllEnvStaleCounts()).size).toBe(1);

        // Tick 2: mollifier flips OFF — getBuffer returns null. The
        // sweep must clear the durable state.
        await runStaleSweepOnce(cfg, {
          ...spies.deps,
          getBuffer: () => null,
          state,
        });
        expect(spies.snapshots[1].size).toBe(0);
        expect((await state.readAllEnvStaleCounts()).size).toBe(0);
        expect(await state.readCursor()).toBe(0);
      } finally {
        await state.close();
        await buffer.close();
      }
    }
  );
});

describe("MollifierStaleSweepState — direct unit tests", () => {
  redisTest(
    "readCursor returns 0 when the key is absent",
    { timeout: 20_000 },
    async ({ redisOptions }) => {
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        expect(await state.readCursor()).toBe(0);
      } finally {
        await state.close();
      }
    }
  );

  redisTest(
    "writeCursor + readCursor round-trip; readCursor parses a non-numeric value as 0",
    { timeout: 20_000 },
    async ({ redisOptions }) => {
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        await state.writeCursor(42);
        expect(await state.readCursor()).toBe(42);

        // Defensive: a corrupted/garbage value must not throw or
        // propagate NaN into the sweep's cursor arithmetic.
        await state["redis"].set("mollifier:stale_sweep:cursor", "not-a-number");
        expect(await state.readCursor()).toBe(0);
      } finally {
        await state.close();
      }
    }
  );

  redisTest(
    "rebuildOrgList replaces the previous list (DEL + RPUSH, in order)",
    { timeout: 20_000 },
    async ({ redisOptions }) => {
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        await state.rebuildOrgList(["org_a", "org_b", "org_c"]);
        let slice = await state.readOrgListSlice(0, 10);
        expect(slice.total).toBe(3);
        expect(slice.orgs).toEqual(["org_a", "org_b", "org_c"]);

        // Replacement, not append.
        await state.rebuildOrgList(["org_x"]);
        slice = await state.readOrgListSlice(0, 10);
        expect(slice.total).toBe(1);
        expect(slice.orgs).toEqual(["org_x"]);

        // Empty rebuild leaves the list empty (DEL fires, no RPUSH).
        await state.rebuildOrgList([]);
        slice = await state.readOrgListSlice(0, 10);
        expect(slice.total).toBe(0);
        expect(slice.orgs).toEqual([]);
      } finally {
        await state.close();
      }
    }
  );

  redisTest(
    "setEnvStaleCount HSETs when count > 0 and HDELs when count === 0",
    { timeout: 20_000 },
    async ({ redisOptions }) => {
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        await state.setEnvStaleCount("env_a", 3);
        await state.setEnvStaleCount("env_b", 1);
        let counts = await state.readAllEnvStaleCounts();
        expect(Object.fromEntries(counts)).toEqual({ env_a: 3, env_b: 1 });

        // Zero clears the field (HDEL), not stores 0.
        await state.setEnvStaleCount("env_a", 0);
        counts = await state.readAllEnvStaleCounts();
        expect(Object.fromEntries(counts)).toEqual({ env_b: 1 });
        expect(counts.has("env_a")).toBe(false);
      } finally {
        await state.close();
      }
    }
  );

  redisTest(
    "clearAll DELs cursor, org_list, and counts in one call",
    { timeout: 20_000 },
    async ({ redisOptions }) => {
      const state = new MollifierStaleSweepState({ redisOptions });
      try {
        await state.writeCursor(7);
        await state.rebuildOrgList(["org_a", "org_b"]);
        await state.setEnvStaleCount("env_a", 5);

        await state.clearAll();

        expect(await state.readCursor()).toBe(0);
        expect((await state.readOrgListSlice(0, 10)).total).toBe(0);
        expect((await state.readAllEnvStaleCounts()).size).toBe(0);
      } finally {
        await state.close();
      }
    }
  );
});

describe("startStaleSweepInterval — lifecycle", () => {
  it("stop() waits for an in-flight tick to finish before closing the state", async () => {
    // Devin's BUG report on PR #3754: `stop()` previously called
    // `deps.state.close()` immediately after `clearInterval`, but the
    // `tick` function only checks `stopped` at entry. A tick that was
    // already past that check would keep making `state.*` Redis calls
    // against a now-closed ioredis client, throw, get caught by tick's
    // own try/catch, and log a `mollifier.stale_sweep.failed` warning
    // for every graceful shutdown.
    //
    // The fix tracks the current tick promise so `stop()` can await it
    // before closing. This test pins that order by gating one of the
    // tick's state calls on a Deferred — until we resolve it, the tick
    // can't progress, and `stop()` must hang in the meantime.
    let resolveGate: () => void = () => {};
    const gate = new Promise<void>((r) => {
      resolveGate = r;
    });

    const callOrder: string[] = [];
    let closeCalled = false;
    const state = {
      readCursor: async () => {
        callOrder.push("readCursor:start");
        await gate;
        callOrder.push("readCursor:end");
        return 0;
      },
      writeCursor: async () => {
        callOrder.push("writeCursor");
      },
      rebuildOrgList: async () => {
        callOrder.push("rebuildOrgList");
      },
      readOrgListSlice: async () => {
        callOrder.push("readOrgListSlice");
        // Return zero orgs so the org loop is a no-op — we only care
        // about ordering of state calls vs close, not the work.
        return { orgs: [] as string[], total: 0 };
      },
      setEnvStaleCount: async () => {
        callOrder.push("setEnvStaleCount");
      },
      readAllEnvStaleCounts: async () => {
        callOrder.push("readAllEnvStaleCounts");
        return new Map<string, number>();
      },
      markEnvVisited: async () => {
        callOrder.push("markEnvVisited");
      },
      reconcileVisited: async () => {
        callOrder.push("reconcileVisited");
      },
      clearAll: async () => {
        callOrder.push("clearAll");
      },
      close: async () => {
        callOrder.push("close");
        closeCalled = true;
      },
    };

    const fakeBuffer = {
      listOrgs: async () => [],
      listEnvsForOrg: async () => [],
      listEntriesForEnv: async () => [],
    } as any;

    const handle = startStaleSweepInterval(
      {
        intervalMs: 20,
        staleThresholdMs: 60_000,
        maxOrgsPerPass: 10,
      },
      {
        state,
        getBuffer: () => fakeBuffer,
        recordStaleEntry: () => {},
        reportStaleEntrySnapshot: () => {},
        logger: { warn: () => {} },
        now: () => Date.now(),
      }
    );

    // Wait for the interval to fire one tick. The tick will start, call
    // readCursor, and then block on `gate`.
    await new Promise((r) => setTimeout(r, 80));
    expect(callOrder).toContain("readCursor:start");
    expect(closeCalled).toBe(false);

    // Call stop() concurrently — its promise MUST NOT resolve while the
    // tick is still mid-flight.
    let stopResolved = false;
    const stopPromise = handle.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopResolved).toBe(false);
    expect(closeCalled).toBe(false);

    // Release the gate. The tick can now finish, and only then should
    // stop() resolve and close the state.
    resolveGate();
    await stopPromise;
    expect(stopResolved).toBe(true);
    expect(closeCalled).toBe(true);

    // The tick's readCursor:end MUST appear before the close — otherwise
    // we closed the Redis client out from under an in-flight tick.
    expect(callOrder.indexOf("readCursor:end")).toBeGreaterThan(-1);
    expect(callOrder.indexOf("close")).toBeGreaterThan(callOrder.indexOf("readCursor:end"));
  });
});
