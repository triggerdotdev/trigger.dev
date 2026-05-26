import { describe, expect, it, vi } from "vitest";

// Mock the db module so the BaseService default prisma doesn't try to
// open a real connection at module load. Each test wires its own
// prisma stub.
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
// Prevent the runEngine singleton from instantiating and spinning up
// PG/Redis workers at module load — without this CI fails with
// unhandled `PrismaClientInitializationError`s even though the
// assertions all pass (see `mollifierDrainerWorker.test.ts`).
vi.mock("~/v3/runEngine.server", () => ({ engine: {} }));

// Hoisted mock state so we can swap the buffer per test without
// re-importing modules.
const bufferMock: { current: unknown } = { current: null };
vi.mock("~/v3/mollifier/mollifierBuffer.server", () => ({
  getMollifierBuffer: () => bufferMock.current,
}));

import { ResetIdempotencyKeyService } from "~/v3/services/resetIdempotencyKey.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

type FakePrisma = {
  taskRun: { updateMany: (...args: unknown[]) => Promise<{ count: number }> };
};

function makePrisma(pgCount: number): FakePrisma {
  return {
    taskRun: {
      updateMany: vi.fn(async () => ({ count: pgCount })),
    },
  };
}

const env = {
  id: "env_a",
  organizationId: "org_1",
} as unknown as Parameters<ResetIdempotencyKeyService["call"]>[2];

describe("ResetIdempotencyKeyService — buffer-outage handling", () => {
  it("returns success when PG cleared >=1 run, even if the buffer reset throws", async () => {
    bufferMock.current = {
      resetIdempotency: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const prisma = makePrisma(1);
    const service = new ResetIdempotencyKeyService(prisma as never);

    const result = await service.call("ikey", "task", env);
    expect(result).toEqual({ id: "ikey" });
  });

  it("returns success when PG cleared nothing but the buffer cleared a run", async () => {
    bufferMock.current = {
      resetIdempotency: vi.fn(async () => ({ clearedRunId: "run_x" })),
    };
    const prisma = makePrisma(0);
    const service = new ResetIdempotencyKeyService(prisma as never);

    const result = await service.call("ikey", "task", env);
    expect(result).toEqual({ id: "ikey" });
  });

  it("404s when PG and buffer both legitimately report 'nothing to clear'", async () => {
    bufferMock.current = {
      resetIdempotency: vi.fn(async () => ({ clearedRunId: null })),
    };
    const prisma = makePrisma(0);
    const service = new ResetIdempotencyKeyService(prisma as never);

    await expect(service.call("ikey", "task", env)).rejects.toMatchObject({
      status: 404,
    });
  });

  // Regression for the silent-not-found hazard CodeRabbit flagged: if PG
  // sees nothing AND we can't read the buffer (Redis outage), the
  // previous behaviour was to 404 — masking a partial outage and
  // leaving a buffered key effectively un-reset while the caller was
  // told "doesn't exist." We now surface 503 so the caller retries.
  it("503s when PG cleared nothing AND the buffer reset failed (partial outage)", async () => {
    bufferMock.current = {
      resetIdempotency: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    };
    const prisma = makePrisma(0);
    const service = new ResetIdempotencyKeyService(prisma as never);

    const error = await service.call("ikey", "task", env).then(
      () => null,
      (err) => err,
    );
    expect(error).toBeInstanceOf(ServiceValidationError);
    expect(error.status).toBe(503);
    expect(error.message).toMatch(/retry/i);
  });

  it("404s normally when buffer is null (mollifier disabled) and PG cleared nothing", async () => {
    bufferMock.current = null;
    const prisma = makePrisma(0);
    const service = new ResetIdempotencyKeyService(prisma as never);

    await expect(service.call("ikey", "task", env)).rejects.toMatchObject({
      status: 404,
    });
  });
});
