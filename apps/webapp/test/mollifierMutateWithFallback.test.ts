import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: { taskRun: { findFirst: vi.fn(async () => null) } },
  $replica: { taskRun: { findFirst: vi.fn(async () => null) } },
}));

import { mutateWithFallback } from "~/v3/mollifier/mutateWithFallback.server";
import type { MollifierBuffer, MutateSnapshotResult } from "@trigger.dev/redis-worker";
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
  } as unknown as MollifierBuffer;
}

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

  it("replica miss + buffer busy + writer resolves mid-wait → pgMutation", async () => {
    const row = fakeRun();
    const pgMutation = vi.fn(async () => "pg-after-wait");
    // Replica misses; writer misses twice, then hits.
    const writer = fakePrisma([null, null, row]);
    let nowValue = 0;
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation,
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: writer as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => bufferReturning("busy"),
      sleep: async () => {
        nowValue += 20;
      },
      now: () => nowValue,
      safetyNetMs: 2000,
      pollStepMs: 20,
      pgTimeoutMs: 50,
    });
    expect(result).toEqual({ kind: "pg", response: "pg-after-wait" });
    expect(pgMutation).toHaveBeenCalledWith(row);
    // Writer should have been polled 3 times before the hit.
    expect(writer.taskRun.findFirst).toHaveBeenCalledTimes(3);
  });

  it("replica miss + buffer busy + drainer never resolves → timed_out", async () => {
    let nowValue = 0;
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation: async () => "pg",
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: fakePrisma([null, null, null, null, null]) as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => bufferReturning("busy"),
      sleep: async () => {
        nowValue += 20;
      },
      now: () => nowValue,
      safetyNetMs: 60,
      pollStepMs: 20,
      pgTimeoutMs: 5,
    });
    expect(result).toEqual({ kind: "timed_out" });
  });

  it("abort signal during wait → timed_out without further polls", async () => {
    const writer = fakePrisma([null, null, null]);
    const controller = new AbortController();
    let nowValue = 0;
    const result = await mutateWithFallback({
      ...baseInput,
      pgMutation: async () => "pg",
      synthesisedResponse: () => "snap",
      prismaReplica: fakePrisma([null]) as unknown as typeof import("~/db.server").$replica,
      prismaWriter: writer as unknown as typeof import("~/db.server").prisma,
      getBuffer: () => bufferReturning("busy"),
      sleep: async () => {
        nowValue += 20;
        controller.abort();
      },
      now: () => nowValue,
      safetyNetMs: 2000,
      pollStepMs: 20,
      pgTimeoutMs: 5,
      abortSignal: controller.signal,
    });
    expect(result).toEqual({ kind: "timed_out" });
    // One poll happened before the sleep+abort.
    expect(writer.taskRun.findFirst).toHaveBeenCalledTimes(1);
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
