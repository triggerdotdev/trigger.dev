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

function bufferReturning(result: MutateSnapshotResult): MollifierBuffer {
  return {
    mutateSnapshot: vi.fn(async () => result),
    getEntry: vi.fn(async () => null),
  } as unknown as MollifierBuffer;
}

// Buffer whose mutateSnapshot returns "busy" and whose getEntry walks a
// scripted sequence of entry states (the drainer's progress). The last
// element repeats once the sequence is exhausted.
function bufferBusy(entries: Array<BufferEntry | null>): MollifierBuffer {
  const getEntry = vi.fn();
  for (const e of entries) getEntry.mockResolvedValueOnce(e);
  getEntry.mockResolvedValue(entries.length ? entries[entries.length - 1] : null);
  return {
    mutateSnapshot: vi.fn(async () => "busy" as const),
    getEntry,
  } as unknown as MollifierBuffer;
}

const entryDraining = (): BufferEntry =>
  ({ status: "DRAINING", materialised: false }) as unknown as BufferEntry;
const entryQueued = (): BufferEntry =>
  ({ status: "QUEUED", materialised: false }) as unknown as BufferEntry;
const entryMaterialised = (): BufferEntry =>
  ({ status: "DRAINING", materialised: true }) as unknown as BufferEntry;

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
    // Detection happened against Redis (3 polls), the primary exactly once.
    expect(buffer.getEntry).toHaveBeenCalledTimes(3);
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
    expect(buffer.getEntry).toHaveBeenCalledTimes(3);
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
    // One buffer poll happened before the sleep+abort; primary untouched.
    expect(buffer.getEntry).toHaveBeenCalledTimes(1);
    expect(writer.taskRun.findFirst).toHaveBeenCalledTimes(0);
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
