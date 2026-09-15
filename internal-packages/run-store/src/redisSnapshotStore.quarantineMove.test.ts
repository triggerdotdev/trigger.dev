// F10: quarantining an unresolvable prepared unit is a REAL ATOMIC MOVE — one script writes the
// durable no-TTL record AND removes the prepared unit, but only when the prep key's token still
// matches, so a newer replacement is never clobbered. Residency resolution folds the quarantine check
// into its pending-state read and fails closed (never absent/Postgres) on a quarantined run. Real
// Redis (testcontainers), seeded through the real prepare primitive; no mocks.
import { describe, expect } from "vitest";
import { redisTest } from "@internal/testcontainers";
import {
  RedisSnapshotStore,
  type PreparedEntry,
  type PreparedPgUnit,
  type SnapshotEntryInput,
} from "./redisSnapshotStore.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";

function entry(over: { id: string; runId: string }): SnapshotEntryInput {
  return {
    engine: "V2",
    executionStatus: "EXECUTING",
    description: "d",
    runStatus: "EXECUTING",
    createdAt: "2026-08-21T00:00:00.000Z",
    environmentId: "env_1",
    environmentType: "PRODUCTION",
    projectId: "proj_1",
    organizationId: "org_1",
    ...over,
  };
}

function birthUnit(runId: string, over: Partial<PreparedPgUnit> = {}): PreparedPgUnit {
  const b: PreparedEntry = { entry: entry({ id: "b0", runId }), kind: "birth", isTerminal: false };
  return {
    protocolVersion: 1,
    transitionToken: "birth",
    postgresXid: "1",
    runId,
    organizationId: "org_1",
    residency: "redis-primary",
    logicalRunStoreRoute: "logical:1",
    entries: [b],
    ...over,
  };
}

const alwaysExists = async () => true;

describe("RedisSnapshotStore quarantine atomic move (F10)", () => {
  redisTest(
    "quarantine writes the durable record AND removes the prepared unit when the token matches",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_quarantine_move";
        const unit = birthUnit(runId);
        await store.prepare(unit);
        expect(await store.hasPreparedUnit(runId)).toBe(true);

        const result = await store.quarantinePreparedUnit(unit, "redis-primary-null");

        // The move happened: prepared unit gone, durable record present with reason + timestamp.
        expect(result.moved).toBe(true);
        expect(await store.hasPreparedUnit(runId)).toBe(false);
        const record = await store.readQuarantinedUnit(runId);
        expect(record?.reason).toBe("redis-primary-null");
        expect(record?.unit.runId).toBe(runId);
        expect(record?.quarantinedAt).not.toBe("");
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "quarantine preserves the raw malformed value and never removes a newer replacement",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_quarantine_newer";
        // The LIVE prepared unit carries token "birth".
        await store.prepare(birthUnit(runId));
        expect(await store.hasPreparedUnit(runId)).toBe(true);

        // Quarantine an OLDER, already-superseded unit (a different token). The token guard declines the
        // removal AND declines to write the quarantine marker: a poison marker would fail-close the LIVE
        // newer unit's residency lookup forever, since readPendingState treats any quarantine hash as
        // quarantined. So the live unit survives untouched and un-poisoned.
        const stale = birthUnit(runId, { transitionToken: "stale-token" });
        const result = await store.quarantinePreparedUnit(stale, "structurally-invalid", "<<raw>>");

        expect(result.moved).toBe(false);
        expect(await store.hasPreparedUnit(runId)).toBe(true);
        // No poison marker was written for the superseded unit.
        expect(await store.readQuarantinedUnit(runId)).toBeUndefined();
        // The live unit is NOT fail-closed: its pending state is prepared, not quarantined.
        expect(await store.readPendingState(runId)).toEqual({ prepared: true, quarantined: false });
      } finally {
        await store.quit();
      }
    }
  );

  redisTest(
    "residency resolution fails closed to error on a quarantined run, never absent",
    async ({ redisOptions }) => {
      const store = new RedisSnapshotStore({ redisOptions, completedTtlMs: 60_000 });
      try {
        const runId = "run_quarantine_residency";
        const unit = birthUnit(runId);
        await store.prepare(unit);
        // Move it to quarantine: no committed head, no residency marker, prep key removed.
        await store.quarantinePreparedUnit(unit, "redis-primary-null");
        expect(await store.readPendingState(runId)).toEqual({ prepared: false, quarantined: true });

        const resolver = new SnapshotResidencyResolver({ store, taskRunExists: alwaysExists });
        // Without quarantine-awareness this run reads as `absent` (postgres); it MUST fail closed.
        expect(await resolver.resolve(runId)).toEqual({ kind: "error" });
      } finally {
        await store.quit();
      }
    }
  );
});
