import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({
  // Both default clients return null. Individual tests inject their
  // own fakes via `deps` when they want non-default behaviour.
  prisma: { taskRun: { findFirst: vi.fn(async () => null) } },
  $replica: { taskRun: { findFirst: vi.fn(async () => null) } },
}));

import { resolveRunForMutation } from "~/v3/mollifier/resolveRunForMutation.server";
import type { BufferEntry, MollifierBuffer } from "@trigger.dev/redis-worker";

// Regression coverage for the cancel-route 404 bug (commit b490afe23).
// Before the fix the route had `findResource: async () => null`, which
// caused the route builder to 404 every cancel — including for valid
// PG-row runs — BEFORE the action handler could run. The helper
// resolveRunForMutation has to return a non-null discriminated value
// whenever the run exists in either store.

const NOW = new Date("2026-05-21T10:00:00Z");

function fakeReplica(row: { friendlyId: string } | null) {
  return { taskRun: { findFirst: vi.fn(async () => row) } };
}
function fakeWriter(row: { friendlyId: string } | null) {
  return { taskRun: { findFirst: vi.fn(async () => row) } };
}

function fakeBuffer(entry: BufferEntry | null): MollifierBuffer {
  return {
    getEntry: vi.fn(async () => entry),
  } as unknown as MollifierBuffer;
}

const baseInput = {
  runParam: "run_1",
  environmentId: "env_a",
  organizationId: "org_1",
};

describe("resolveRunForMutation", () => {
  it("returns { source: 'pg' } when the PG row exists", async () => {
    const result = await resolveRunForMutation({
      ...baseInput,
      deps: {
        prismaReplica: fakeReplica({ friendlyId: "run_1" }),
        getBuffer: () => null,
      },
    });
    expect(result).toEqual({ source: "pg", friendlyId: "run_1" });
  });

  it("returns { source: 'buffer' } when PG misses and the buffer entry matches env+org", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: "{}",
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
      createdAtMicros: 1747044000000000,
      materialised: false,
      idempotencyLookupKey: "",
      metadataVersion: 0,
    };
    const result = await resolveRunForMutation({
      ...baseInput,
      deps: {
        prismaReplica: fakeReplica(null),
        getBuffer: () => fakeBuffer(entry),
      },
    });
    expect(result).toEqual({ source: "buffer", friendlyId: "run_1" });
  });

  it("returns null when PG misses and the buffer entry env doesn't match", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_OTHER",
      orgId: "org_1",
      payload: "{}",
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
      createdAtMicros: 1747044000000000,
      materialised: false,
      idempotencyLookupKey: "",
      metadataVersion: 0,
    };
    const result = await resolveRunForMutation({
      ...baseInput,
      deps: {
        prismaReplica: fakeReplica(null),
        getBuffer: () => fakeBuffer(entry),
      },
    });
    expect(result).toBeNull();
  });

  it("returns null when PG misses and the buffer entry org doesn't match", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_OTHER",
      payload: "{}",
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
      createdAtMicros: 1747044000000000,
      materialised: false,
      idempotencyLookupKey: "",
      metadataVersion: 0,
    };
    const result = await resolveRunForMutation({
      ...baseInput,
      deps: {
        prismaReplica: fakeReplica(null),
        getBuffer: () => fakeBuffer(entry),
      },
    });
    expect(result).toBeNull();
  });

  it("returns null when both PG and buffer miss", async () => {
    const result = await resolveRunForMutation({
      ...baseInput,
      deps: {
        prismaReplica: fakeReplica(null),
        getBuffer: () => fakeBuffer(null),
      },
    });
    expect(result).toBeNull();
  });

  it("returns null when buffer is unavailable (mollifier disabled) and PG misses", async () => {
    const result = await resolveRunForMutation({
      ...baseInput,
      deps: {
        prismaReplica: fakeReplica(null),
        getBuffer: () => null,
      },
    });
    expect(result).toBeNull();
  });

  it("PG-hit short-circuits before consulting the buffer", async () => {
    const buffer = fakeBuffer(null);
    const result = await resolveRunForMutation({
      ...baseInput,
      deps: {
        prismaReplica: fakeReplica({ friendlyId: "run_1" }),
        getBuffer: () => buffer,
      },
    });
    expect(result?.source).toBe("pg");
    expect(buffer.getEntry).not.toHaveBeenCalled();
  });

  // Regressions for the degraded-mode false-404 CodeRabbit flagged.
  //
  // Pre-PR the mutation routes read from the writer directly, so any
  // PG row was visible regardless of replication lag. This helper
  // moved the read to the replica for offload purposes. The route
  // builder treats a null return as a hard 404 BEFORE the action
  // handler runs, so any path where replica misses and the writer has
  // the row needs to be reachable here — otherwise mutateWithFallback's
  // own writer recovery never gets a chance to fire.
  it("falls back to the writer when both replica and buffer miss, returning the writer row as 'pg' source", async () => {
    const result = await resolveRunForMutation({
      ...baseInput,
      deps: {
        prismaReplica: fakeReplica(null),
        prismaWriter: fakeWriter({ friendlyId: "run_1" }),
        getBuffer: () => fakeBuffer(null),
      },
    });
    expect(result?.source).toBe("pg");
    expect(result?.friendlyId).toBe("run_1");
  });

  it("falls back to the writer when the buffer is unavailable (mollifier disabled) and replica misses", async () => {
    const result = await resolveRunForMutation({
      ...baseInput,
      deps: {
        prismaReplica: fakeReplica(null),
        prismaWriter: fakeWriter({ friendlyId: "run_1" }),
        getBuffer: () => null,
      },
    });
    expect(result?.source).toBe("pg");
    expect(result?.friendlyId).toBe("run_1");
  });

  it("still returns null when replica, buffer, AND writer all miss (legitimate not-found)", async () => {
    const writer = fakeWriter(null);
    const result = await resolveRunForMutation({
      ...baseInput,
      deps: {
        prismaReplica: fakeReplica(null),
        prismaWriter: writer,
        getBuffer: () => fakeBuffer(null),
      },
    });
    expect(result).toBeNull();
    // Writer probe ran — the fallback fires exactly once on the miss
    // path; doesn't pile retries.
    expect(writer.taskRun.findFirst).toHaveBeenCalledOnce();
  });

  it("PG-hit short-circuits before consulting either the buffer OR the writer", async () => {
    const buffer = fakeBuffer(null);
    const writer = fakeWriter({ friendlyId: "should-not-be-read" });
    const result = await resolveRunForMutation({
      ...baseInput,
      deps: {
        prismaReplica: fakeReplica({ friendlyId: "run_1" }),
        prismaWriter: writer,
        getBuffer: () => buffer,
      },
    });
    expect(result?.source).toBe("pg");
    expect(result?.friendlyId).toBe("run_1");
    expect(buffer.getEntry).not.toHaveBeenCalled();
    // Writer must NOT fire when the replica already had the row —
    // otherwise we'd negate the whole replica-offload purpose.
    expect(writer.taskRun.findFirst).not.toHaveBeenCalled();
  });
});
