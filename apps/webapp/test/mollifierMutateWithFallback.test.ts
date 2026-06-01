import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: { taskRun: { findFirst: vi.fn(async () => null) } },
  $replica: { taskRun: { findFirst: vi.fn(async () => null) } },
}));

import { mutateWithFallback } from "~/v3/mollifier/mutateWithFallback.server";
import type {
  BufferEntry,
  MollifierBuffer,
  MutateSnapshotResult,
} from "@trigger.dev/redis-worker";
import type { TaskRun } from "@trigger.dev/database";

type FindFirst = ReturnType<typeof vi.fn>;
type PrismaStub = { taskRun: { findFirst: FindFirst } };

function fakePrisma(rows: Array<TaskRun | null>): PrismaStub {
  const fn = vi.fn();
  for (const r of rows) fn.mockResolvedValueOnce(r);
  fn.mockResolvedValue(null);
  return { taskRun: { findFirst: fn } };
}

// Env-matching entry returned by the env-pre-check getEntry call that
// mutateWithFallback now does before any buffer write (cross-env auth
// gate). Same envId/orgId as `baseInput` so the check passes and the
// flow under test proceeds to mutateSnapshot.
const preCheckEntry = (): BufferEntry =>
  ({
    envId: "env_a",
    orgId: "org_1",
    status: "QUEUED",
    materialised: false,
  }) as unknown as BufferEntry;

function bufferReturning(result: MutateSnapshotResult): MollifierBuffer {
  const getEntry = vi.fn(async () => preCheckEntry());
  return {
    mutateSnapshot: vi.fn(async () => result),
    getEntry,
  } as unknown as MollifierBuffer;
}

// Buffer whose mutateSnapshot returns "busy" and whose getEntry walks a
// scripted sequence of entry states. The pre-check getEntry call (one
// extra read before the busy-wait loop, used for env authorization)
// consumes the first scripted result, then the busy-wait loop pops the
// remainder; the last element repeats once the sequence is exhausted.
function bufferBusy(entries: Array<BufferEntry | null>): MollifierBuffer {
  const getEntry = vi.fn();
  // Pre-check consumes one entry. Use a QUEUED env-matching entry so
  // the env-check passes and the flow reaches mutateSnapshot (which
  // returns "busy") and enters the wait-loop.
  getEntry.mockResolvedValueOnce(preCheckEntry());
  for (const e of entries) getEntry.mockResolvedValueOnce(e);
  getEntry.mockResolvedValue(entries.length ? entries[entries.length - 1] : null);
  return {
    mutateSnapshot: vi.fn(async () => "busy" as const),
    getEntry,
  } as unknown as MollifierBuffer;
}

const entryDraining = (): BufferEntry =>
  ({
    envId: "env_a",
    orgId: "org_1",
    status: "DRAINING",
    materialised: false,
  }) as unknown as BufferEntry;
const entryQueued = (): BufferEntry =>
  ({
    envId: "env_a",
    orgId: "org_1",
    status: "QUEUED",
    materialised: false,
  }) as unknown as BufferEntry;
const entryMaterialised = (): BufferEntry =>
  ({
    envId: "env_a",
    orgId: "org_1",
    status: "DRAINING",
    materialised: true,
  }) as unknown as BufferEntry;

const fakeRun = (overrides: Partial<TaskRun> = {}): TaskRun =>
  ({
    id: "pg_id",
    friendlyId: "run_1",
    runtimeEnvironmentId: "env_a",
    ...overrides,
  }) as TaskRun;

const baseInput = {
  runId: "run_1",
  environmentId: "env_a",
  organizationId: "org_1",
  bufferPatch: { type: "append_tags" as const, tags: ["x"] },
};

describe("mutateWithFallback", () => {
  it("hits replica → calls pgMutation, returns pg outcome", async () => {
    const row = fakeRun();
    const pgMutation = vi.fn(async () => "pg-response");
    const synthesisedResponse = vi.fn(() => "snapshot-response");

    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation,
      synthesisedResponse,
      prismaReplica: fakePrisma([row]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => bufferReturning("applied_to_snapshot"),
    });

    expect(result).toEqual({ kind: "pg", response: "pg-response" });
    expect(pgMutation).toHaveBeenCalledWith(row);
    expect(synthesisedResponse).not.toHaveBeenCalled();
  });

  it("replica miss + buffer applied_to_snapshot → synthesisedResponse", async () => {
    const pgMutation = vi.fn(async () => "pg");
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation,
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => bufferReturning("applied_to_snapshot"),
    });
    expect(result).toEqual({ kind: "snapshot", response: "snap" });
    expect(pgMutation).not.toHaveBeenCalled();
  });

  it("applied_to_snapshot forwards the pre-mutation entry to synthesisedResponse (lets callers dedup)", async () => {
    // The tags route uses this to compute the same post-dedup count
    // the PG path reports, without an extra Redis round-trip.
    const synthesised = vi.fn(({ bufferEntry }: { bufferEntry: BufferEntry | null }) => {
      // Caller can inspect bufferEntry.payload (or other fields) to
      // produce a response that depends on the prior snapshot state.
      return bufferEntry ? "snap-with-entry" : "snap-without-entry";
    });
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation: async () => "pg",
      synthesisedResponse: synthesised,
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => bufferReturning("applied_to_snapshot"),
    });
    expect(result).toEqual({ kind: "snapshot", response: "snap-with-entry" });
    expect(synthesised).toHaveBeenCalledTimes(1);
    const ctx = synthesised.mock.calls[0]?.[0];
    expect(ctx?.bufferEntry).not.toBeNull();
    // The pre-check entry has the env-matching shape set up by
    // bufferReturning() / preCheckEntry().
    expect(ctx?.bufferEntry?.envId).toBe("env_a");
    expect(ctx?.bufferEntry?.orgId).toBe("org_1");
  });

  // Symmetric writer-fallback in the `!buffer` short-circuit. Without
  // this, mollifier-disabled deployments (or boot-time buffer init
  // failures) would regress the pre-PR mutation routes — those read
  // from the writer directly, so a fresh PG row was always visible.
  // The replica offload introduced here moves the read to the lagging
  // follower; if the buffer isn't available to disambiguate, we still
  // probe the writer before returning 404.
  it("replica miss + !buffer + writer hit → pgMutation (mollifier-disabled mode recovery)", async () => {
    const row = fakeRun({ friendlyId: "run_1" });
    const pgMutation = vi.fn(async () => "pg-recovered-no-buffer");
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation,
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([row]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => null,
    });
    expect(result).toEqual({ kind: "pg", response: "pg-recovered-no-buffer" });
    expect(pgMutation).toHaveBeenCalledWith(row);
  });

  it("replica miss + !buffer + writer miss → not_found (genuine 404 in mollifier-disabled mode)", async () => {
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation: async () => "pg",
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([null]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => null,
    });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("replica miss + buffer not_found + writer miss → not_found", async () => {
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation: async () => "pg",
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([null]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => bufferReturning("not_found"),
    });
    expect(result).toEqual({ kind: "not_found" });
  });

  it("replica miss + buffer not_found + writer hit → pgMutation (replica-lag recovery)", async () => {
    const row = fakeRun({ friendlyId: "run_1" });
    const pgMutation = vi.fn(async () => "pg-recovered");
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation,
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([row]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => bufferReturning("not_found"),
    });
    expect(result).toEqual({ kind: "pg", response: "pg-recovered" });
    expect(pgMutation).toHaveBeenCalledWith(row);
  });

  it("busy → watches buffer through DRAINING, materialises, hits primary exactly once", async () => {
    const row = fakeRun();
    const pgMutation = vi.fn(async () => "pg-after-wait");
    // Writer is read ONCE, only after the buffer reports materialised.
    const writer = fakePrisma([row]);
    const buffer = bufferBusy([entryDraining(), entryDraining(), entryMaterialised()]);
    let nowValue = 0;
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation,
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: writer as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => buffer,
      sleep: async (ms) => {
        nowValue += ms;
      },
      now: () => nowValue,
      safetyNetMs: 2000,
      pollStepMs: 20,
      random: () => 0,
    });
    expect(result).toEqual({ kind: "pg", response: "pg-after-wait" });
    expect(pgMutation).toHaveBeenCalledWith(row);
    // One env-pre-check call + 3 busy-wait polls = 4 getEntry reads;
    // primary read exactly once.
    expect(buffer.getEntry).toHaveBeenCalledTimes(4);
    expect(writer.taskRun.findFirst).toHaveBeenCalledTimes(1);
  });

  it("busy → entry deleted by terminal fail, writer finds SYSTEM_FAILURE row → pgMutation", async () => {
    const row = fakeRun();
    const pgMutation = vi.fn(async () => "pg-failed-row");
    const writer = fakePrisma([row]);
    const buffer = bufferBusy([entryDraining(), null]);
    let nowValue = 0;
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation,
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: writer as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => buffer,
      sleep: async (ms) => {
        nowValue += ms;
      },
      now: () => nowValue,
      safetyNetMs: 2000,
      pollStepMs: 20,
      random: () => 0,
    });
    expect(result).toEqual({ kind: "pg", response: "pg-failed-row" });
    expect(writer.taskRun.findFirst).toHaveBeenCalledTimes(1);
  });

  it("busy → entry deleted but no PG row (terminal write failed) → not_found", async () => {
    const buffer = bufferBusy([null]);
    const writer = fakePrisma([null]);
    let nowValue = 0;
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation: async () => "pg",
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: writer as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => buffer,
      sleep: async (ms) => {
        nowValue += ms;
      },
      now: () => nowValue,
      safetyNetMs: 2000,
      pollStepMs: 20,
      random: () => 0,
    });
    expect(result).toEqual({ kind: "not_found" });
    expect(writer.taskRun.findFirst).toHaveBeenCalledTimes(1);
  });

  it("busy → requeued (back to QUEUED) then materialises; doesn't resolve early", async () => {
    const row = fakeRun();
    const pgMutation = vi.fn(async () => "pg-after-requeue");
    const writer = fakePrisma([row]);
    // QUEUED (requeued after a retryable drain error) must NOT be treated
    // as "done" — the run hasn't reached PG. Only the later materialise does.
    const buffer = bufferBusy([entryQueued(), entryDraining(), entryMaterialised()]);
    let nowValue = 0;
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation,
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: writer as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => buffer,
      sleep: async (ms) => {
        nowValue += ms;
      },
      now: () => nowValue,
      safetyNetMs: 2000,
      pollStepMs: 20,
      random: () => 0,
    });
    expect(result).toEqual({ kind: "pg", response: "pg-after-requeue" });
    // One env-pre-check + 3 busy-wait polls.
    expect(buffer.getEntry).toHaveBeenCalledTimes(4);
    expect(writer.taskRun.findFirst).toHaveBeenCalledTimes(1);
  });

  it("busy → drainer never resolves (stays DRAINING) → timed_out, primary never touched", async () => {
    const writer = fakePrisma([]);
    const buffer = bufferBusy([entryDraining()]);
    let nowValue = 0;
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation: async () => "pg",
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: writer as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => buffer,
      sleep: async (ms) => {
        nowValue += ms;
      },
      now: () => nowValue,
      safetyNetMs: 100,
      pollStepMs: 20,
      random: () => 0,
    });
    expect(result).toEqual({ kind: "timed_out" });
    // The whole point: while the run is still draining we never read the primary.
    expect(writer.taskRun.findFirst).toHaveBeenCalledTimes(0);
  });

  it("abort signal during wait → timed_out without further polls", async () => {
    const writer = fakePrisma([]);
    const buffer = bufferBusy([entryDraining(), entryDraining()]);
    const controller = new AbortController();
    let nowValue = 0;
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation: async () => "pg",
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: writer as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => buffer,
      sleep: async (ms) => {
        nowValue += ms;
        controller.abort();
      },
      now: () => nowValue,
      safetyNetMs: 2000,
      pollStepMs: 20,
      random: () => 0,
      abortSignal: controller.signal,
    });
    expect(result).toEqual({ kind: "timed_out" });
    // One env-pre-check + one busy-wait poll before sleep+abort; primary untouched.
    expect(buffer.getEntry).toHaveBeenCalledTimes(2);
    expect(writer.taskRun.findFirst).toHaveBeenCalledTimes(0);
  });

  it("replica miss + buffer limit_exceeded → rejected via rejectedResponse builder", async () => {
    const pgMutation = vi.fn(async () => "pg");
    const synthesisedResponse = vi.fn(() => "snap");
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation,
      synthesisedResponse,
      rejectedResponse: () => "too-many-tags",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => bufferReturning("limit_exceeded"),
    });
    expect(result).toEqual({ kind: "rejected", response: "too-many-tags" });
    expect(pgMutation).not.toHaveBeenCalled();
    expect(synthesisedResponse).not.toHaveBeenCalled();
  });

  it("buffer limit_exceeded without a rejectedResponse builder → throws (programmer error)", async () => {
    await expect(
      mutateWithFallback({
        ...baseInput,
        pgMutation: async () => "pg",
        synthesisedResponse: () => "snap",
        prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
        prismaWriter: fakePrisma([]) as unknown as typeof import("~/db.server").prisma,
        getBuffer: () => bufferReturning("limit_exceeded"),
      })
    ).rejects.toThrow(/limit_exceeded/);
  });

  it("replica miss + buffer entry belongs to a different env → not_found (cross-env auth gate)", async () => {
    // Same flow as the applied_to_snapshot test, except the entry's
    // envId doesn't match input.environmentId. mutateWithFallback must
    // refuse the write and return not_found (without leaking that the
    // runId exists in another env), and must NOT call mutateSnapshot.
    const crossEnvEntry: BufferEntry = {
      envId: "env_OTHER",
      orgId: "org_1",
      status: "QUEUED",
      materialised: false,
    } as unknown as BufferEntry;
    const mutateSnapshot = vi.fn(async () => "applied_to_snapshot" as const);
    const buffer = {
      mutateSnapshot,
      getEntry: vi.fn(async () => crossEnvEntry),
    } as unknown as MollifierBuffer;

    const pgMutation = vi.fn(async () => "pg");
    const synthesisedResponse = vi.fn(() => "snap");
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation,
      synthesisedResponse,
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => buffer,
    });
    expect(result).toEqual({ kind: "not_found" });
    expect(mutateSnapshot).not.toHaveBeenCalled();
    expect(pgMutation).not.toHaveBeenCalled();
    expect(synthesisedResponse).not.toHaveBeenCalled();
  });

  it("replica miss + buffer entry belongs to a different org → not_found (cross-org auth gate)", async () => {
    const crossOrgEntry: BufferEntry = {
      envId: "env_a",
      orgId: "org_OTHER",
      status: "QUEUED",
      materialised: false,
    } as unknown as BufferEntry;
    const mutateSnapshot = vi.fn(async () => "applied_to_snapshot" as const);
    const buffer = {
      mutateSnapshot,
      getEntry: vi.fn(async () => crossOrgEntry),
    } as unknown as MollifierBuffer;

    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation: async () => "pg",
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => buffer,
    });
    expect(result).toEqual({ kind: "not_found" });
    expect(mutateSnapshot).not.toHaveBeenCalled();
  });

  it("buffer is null (mollifier disabled) → not_found after replica miss", async () => {
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation: async () => "pg",
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => null,
    });
    expect(result).toEqual({ kind: "not_found" });
  });
});
