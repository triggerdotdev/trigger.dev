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

  it("returns null when buffer entry orgId does not match caller (auth mismatch)", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_OTHER",
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

  it("extracts snapshot-derived fields from the buffered payload", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({
        taskIdentifier: "my-task",
        payload: '{"foo":"bar"}',
        payloadType: "application/json",
        metadata: '{"customer":"acme"}',
        metadataType: "application/json",
        idempotencyKey: "client-abc",
        idempotencyKeyOptions: ["payload"],
        isTest: true,
        depth: 2,
        ttl: "1h",
        tags: ["tag-a", "tag-b"],
        lockToVersion: "20260511.1",
        resumeParentOnCompletion: false,
        parentTaskRunId: "run_parent",
      }),
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result).not.toBeNull();
    expect(result!.payloadType).toBe("application/json");
    expect(result!.metadata).toBe('{"customer":"acme"}');
    expect(result!.metadataType).toBe("application/json");
    expect(result!.idempotencyKey).toBe("client-abc");
    expect(result!.idempotencyKeyOptions).toEqual(["payload"]);
    expect(result!.isTest).toBe(true);
    expect(result!.depth).toBe(2);
    expect(result!.ttl).toBe("1h");
    expect(result!.tags).toEqual(["tag-a", "tag-b"]);
    expect(result!.lockedToVersion).toBe("20260511.1");
    expect(result!.resumeParentOnCompletion).toBe(false);
    expect(result!.parentTaskRunId).toBe("run_parent");
  });

  it("extracts gate-allocated trace context from the snapshot", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({
        taskIdentifier: "t",
        traceId: "trace_abc",
        spanId: "span_xyz",
        parentSpanId: "span_parent",
      }),
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result!.traceId).toBe("trace_abc");
    expect(result!.spanId).toBe("span_xyz");
    expect(result!.parentSpanId).toBe("span_parent");
  });

  it("defaults snapshot-derived fields to safe values when absent", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
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
    expect(result!.payloadType).toBeUndefined();
    expect(result!.metadata).toBeUndefined();
    expect(result!.idempotencyKey).toBeUndefined();
    expect(result!.isTest).toBe(false);
    expect(result!.depth).toBe(0);
    expect(result!.tags).toEqual([]);
    expect(result!.resumeParentOnCompletion).toBe(false);
    expect(result!.traceId).toBeUndefined();
    expect(result!.spanId).toBeUndefined();
  });
});
