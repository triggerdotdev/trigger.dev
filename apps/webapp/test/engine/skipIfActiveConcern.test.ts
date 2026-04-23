import { describe, expect, it, vi } from "vitest";

vi.mock("~/services/logger.server", () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { SkipIfActiveConcern } from "../../app/runEngine/concerns/skipIfActive.server";
import type { TriggerTaskRequest } from "../../app/runEngine/types";

type MockPrisma = {
  $queryRaw: ReturnType<typeof vi.fn>;
  taskRun: { findUnique: ReturnType<typeof vi.fn> };
};

function buildRequest(overrides: {
  skipIfActive?: boolean;
  tags?: string | string[];
  taskId?: string;
  environmentId?: string;
}): TriggerTaskRequest {
  return {
    taskId: overrides.taskId ?? "ezderm-notes-fetch",
    friendlyId: "run_test",
    environment: {
      id: overrides.environmentId ?? "env_123",
      organizationId: "org_1",
      projectId: "proj_1",
    } as TriggerTaskRequest["environment"],
    body: {
      payload: {},
      options: {
        skipIfActive: overrides.skipIfActive,
        tags: overrides.tags,
      },
    },
    options: {},
  } as TriggerTaskRequest;
}

function mockPrisma(initial?: {
  existing?: Array<{ id: string }>;
  run?: { id: string } | null;
}): MockPrisma {
  return {
    $queryRaw: vi.fn().mockResolvedValue(initial?.existing ?? []),
    taskRun: { findUnique: vi.fn().mockResolvedValue(initial?.run ?? null) },
  };
}

describe("SkipIfActiveConcern", () => {
  it("returns wasSkipped=false when the flag is not set", async () => {
    const prisma = mockPrisma();
    const concern = new SkipIfActiveConcern(prisma as never);

    const result = await concern.handleTriggerRequest(
      buildRequest({ skipIfActive: undefined, tags: ["connector:abc"] })
    );

    expect(result).toEqual({ wasSkipped: false });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("returns wasSkipped=false when skipIfActive=false", async () => {
    const prisma = mockPrisma();
    const concern = new SkipIfActiveConcern(prisma as never);

    const result = await concern.handleTriggerRequest(
      buildRequest({ skipIfActive: false, tags: ["connector:abc"] })
    );

    expect(result).toEqual({ wasSkipped: false });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("returns wasSkipped=false when no tags are supplied (tag scope required)", async () => {
    const prisma = mockPrisma();
    const concern = new SkipIfActiveConcern(prisma as never);

    const result = await concern.handleTriggerRequest(
      buildRequest({ skipIfActive: true, tags: undefined })
    );

    expect(result).toEqual({ wasSkipped: false });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("returns wasSkipped=false when no active run matches", async () => {
    const prisma = mockPrisma({ existing: [] });
    const concern = new SkipIfActiveConcern(prisma as never);

    const result = await concern.handleTriggerRequest(
      buildRequest({ skipIfActive: true, tags: ["connector:abc"] })
    );

    expect(result).toEqual({ wasSkipped: false });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.taskRun.findUnique).not.toHaveBeenCalled();
  });

  it("returns wasSkipped=true with the existing run when an active run matches all tags", async () => {
    const existingRun = { id: "run_existing", status: "EXECUTING", runTags: ["connector:abc"] };
    const prisma = mockPrisma({ existing: [{ id: existingRun.id }], run: existingRun });
    const concern = new SkipIfActiveConcern(prisma as never);

    const result = await concern.handleTriggerRequest(
      buildRequest({ skipIfActive: true, tags: ["connector:abc"] })
    );

    expect(result).toMatchObject({ wasSkipped: true, run: existingRun });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.taskRun.findUnique).toHaveBeenCalledWith({ where: { id: "run_existing" } });
  });

  it("normalizes a single tag string into an array", async () => {
    const prisma = mockPrisma({
      existing: [{ id: "run_x" }],
      run: { id: "run_x", status: "PENDING", runTags: ["connector:abc"] },
    });
    const concern = new SkipIfActiveConcern(prisma as never);

    const result = await concern.handleTriggerRequest(
      // @ts-expect-error Zod allows both string and string[] for tags
      buildRequest({ skipIfActive: true, tags: "connector:abc" })
    );

    expect(result.wasSkipped).toBe(true);
  });

  it("recovers gracefully when the row disappears between the probe and the fetch", async () => {
    const prisma = mockPrisma({ existing: [{ id: "run_gone" }], run: null });
    const concern = new SkipIfActiveConcern(prisma as never);

    const result = await concern.handleTriggerRequest(
      buildRequest({ skipIfActive: true, tags: ["connector:abc"] })
    );

    expect(result).toEqual({ wasSkipped: false });
  });
});
