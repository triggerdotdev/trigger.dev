import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import type { MollifierBuffer, BufferEntry } from "@trigger.dev/redis-worker";

function fakeBuffer(entry: BufferEntry | null): MollifierBuffer {
  return {
    getEntry: vi.fn(async () => entry),
  } as unknown as MollifierBuffer;
}

const NOW = new Date("2026-05-11T12:00:00Z");

describe("findRunByIdWithMollifierFallback", () => {
  it("returns null when buffer is unavailable (mollifier disabled)", async () => {
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => null },
    );
    expect(result).toBeNull();
  });

  it("returns null when no buffer entry exists", async () => {
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(null) },
    );
    expect(result).toBeNull();
  });

  it("returns null when buffer entry envId does not match caller (auth mismatch)", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_OTHER",
      orgId: "org_1",
      payload: JSON.stringify({ taskIdentifier: "t" }),
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result).toBeNull();
  });

  it("returns synthesised QUEUED run when entry exists with matching auth", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({ taskIdentifier: "my-task" }),
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result).not.toBeNull();
    expect(result!.friendlyId).toBe("run_1");
    expect(result!.status).toBe("QUEUED");
    expect(result!.taskIdentifier).toBe("my-task");
    expect(result!.createdAt).toEqual(NOW);
  });

  it("returns synthesised QUEUED for DRAINING (internal state same externally)", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({ taskIdentifier: "t" }),
      status: "DRAINING",
      attempts: 1,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result!.status).toBe("QUEUED");
  });

  it("returns FAILED state with structured error for FAILED entries", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({ taskIdentifier: "t" }),
      status: "FAILED",
      attempts: 3,
      createdAt: NOW,
      lastError: { code: "VALIDATION", message: "task not found" },
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result!.status).toBe("FAILED");
    expect(result!.error).toEqual({ code: "VALIDATION", message: "task not found" });
  });
});
