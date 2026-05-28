import { describe, expect, it, vi } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { MollifierBuffer } from "@trigger.dev/redis-worker";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { runStaleSweepOnce } from "~/v3/mollifier/mollifierStaleSweep.server";

const SNAPSHOT = {
  taskIdentifier: "hello-world",
  payload: '{"x":1}',
  payloadType: "application/json",
  traceContext: {},
};

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
      { ...spies.deps, getBuffer: () => null },
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
        const result = await runStaleSweepOnce(
          { staleThresholdMs: 60 * 1000 },
          {
            ...spies.deps,
            getBuffer: () => buffer,
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
        await buffer.close();
      }
    },
  );

  redisTest(
    "snapshot reports zero for envs that have entries but none stale (clears latched alerts)",
    { timeout: 20_000 },
    async ({ redisOptions }) => {
      // Critical for alert behaviour: a previous sweep reported env_a
      // stale, alert fired, drainer caught up. The next sweep must
      // report `env_a -> 0` so the gauge drops below the alert
      // threshold instead of staying latched at the last stale value.
      const buffer = new MollifierBuffer({ redisOptions });
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
          { ...spies.deps, getBuffer: () => buffer },
        );
        expect(spies.snapshots).toHaveLength(1);
        expect(Object.fromEntries(spies.snapshots[0])).toEqual({ env_a: 0 });
      } finally {
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
          { ...spies.deps, getBuffer: () => buffer },
        );
        expect(result.staleCount).toBe(0);
        expect(spies.staleEntryCount).toBe(0);
        expect(spies.warnings).toEqual([]);
      } finally {
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
          { ...spies.deps, getBuffer: () => buffer, now: () => futureNow },
        );
        expect(result.orgsScanned).toBe(2);
        expect(result.envsScanned).toBe(2);
        expect(result.staleCount).toBe(2);
      } finally {
        await buffer.close();
      }
    },
  );
});
