import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
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
});
