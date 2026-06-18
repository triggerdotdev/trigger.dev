import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));

import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import type { MollifierBuffer, BufferEntry } from "@trigger.dev/redis-worker";
import { RunId } from "@trigger.dev/core/v3/isomorphic";

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
        idempotencyKeyOptions: { key: "client-abc", scope: "run" },
        isTest: true,
        depth: 2,
        ttl: "1h",
        tags: ["tag-a", "tag-b"],
        // The engine.trigger snapshot stores the locked version string under
        // `taskVersion` (see triggerTask.server.ts#buildEngineTriggerInput).
        taskVersion: "20260511.1",
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
    expect(result!.idempotencyKeyOptions).toEqual({ key: "client-abc", scope: "run" });
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

  it("parses idempotencyKeyOptions in the canonical { key, scope } object shape (regression for the buffered-vs-PG API contract divergence)", async () => {
    // Regression for the bug where `readFallback` parsed
    // `idempotencyKeyOptions` via Array.isArray and rejected the
    // canonical object shape. The SDK and Prisma both serialise this
    // as `{ key, scope }`; the legacy array check would reject it,
    // returning `undefined` here, which downstream demoted the API's
    // `idempotencyKey` field to surface the *hash* (server-side
    // generated) instead of the user-supplied key — diverging from
    // how materialised runs render the same field, and creating a
    // silent contract flip at the drainer-materialisation boundary.
    // Pin the schema-parse path so the buffered response matches
    // PG-resident behaviour from the moment the run is buffered.
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({
        taskIdentifier: "t",
        idempotencyKey: "<hashed>",
        idempotencyKeyOptions: { key: "user-supplied-key", scope: "global" },
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
    expect(result!.idempotencyKeyOptions).toEqual({
      key: "user-supplied-key",
      scope: "global",
    });
  });

  it("returns undefined for idempotencyKeyOptions when the snapshot carries a legacy/invalid shape", async () => {
    // The Zod schema parse rejects:
    //   - array shape (the legacy bug we just fixed)
    //   - object without required fields
    //   - missing field entirely
    // In all these cases the field is left `undefined`. Downstream
    // `getUserProvidedIdempotencyKey` then falls back to the
    // `idempotencyKey` field, matching how PG-resident runs handle
    // malformed/missing options.
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({
        taskIdentifier: "t",
        idempotencyKey: "<hashed>",
        // Legacy array shape — must NOT be accepted.
        idempotencyKeyOptions: ["payload"],
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
    expect(result!.idempotencyKeyOptions).toBeUndefined();
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

  it("populates replay-relevant fields from the snapshot", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({
        taskIdentifier: "my-task",
        environment: { id: "env_a" },
        workerQueue: "default",
        queue: "task/my-task",
        concurrencyKey: "tenant-42",
        machine: "medium-1x",
        realtimeStreamsVersion: "v2",
        seedMetadata: '{"k":"v"}',
        seedMetadataType: "application/json",
        tags: ["t1", "t2"],
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
    expect(result!.id).toBeTypeOf("string");
    expect(result!.id.length).toBeGreaterThan(0);
    expect(result!.engine).toBe("V2");
    expect(result!.runtimeEnvironmentId).toBe("env_a");
    expect(result!.workerQueue).toBe("default");
    expect(result!.queue).toBe("task/my-task");
    expect(result!.concurrencyKey).toBe("tenant-42");
    expect(result!.machinePreset).toBe("medium-1x");
    expect(result!.realtimeStreamsVersion).toBe("v2");
    expect(result!.seedMetadata).toBe('{"k":"v"}');
    expect(result!.seedMetadataType).toBe("application/json");
    expect(result!.runTags).toEqual(["t1", "t2"]);
  });

  it("extracts batchId from the snapshot's nested batch object (engine.trigger shape)", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({
        taskIdentifier: "t",
        // The engine.trigger input nests the batch as `{ id, index }`,
        // where `id` is the batch's internal cuid (not a flat `batchId`).
        batch: { id: "batch_internal_cuid", index: 3 },
      }),
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result!.batchId).toBe("batch_internal_cuid");
  });

  it("leaves batchId undefined when the snapshot has no batch (non-batched run)", async () => {
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
    expect(result!.batchId).toBeUndefined();
  });

  it("treats invalid date strings as undefined and does not mis-classify status as CANCELED", async () => {
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({
        taskIdentifier: "t",
        cancelledAt: "not-a-date",
        cancelReason: "user requested",
        delayUntil: "also-not-a-date",
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
    expect(result!.status).toBe("QUEUED");
    expect(result!.cancelledAt).toBeUndefined();
    expect(result!.delayUntil).toBeUndefined();
  });

  it("parses valid ISO date strings on cancelledAt and delayUntil", async () => {
    const cancelledAtIso = "2026-05-11T13:00:00.000Z";
    const delayUntilIso = "2026-05-11T14:00:00.000Z";
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({
        taskIdentifier: "t",
        cancelledAt: cancelledAtIso,
        cancelReason: "user requested",
        delayUntil: delayUntilIso,
      }),
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result!.status).toBe("CANCELED");
    expect(result!.cancelledAt).toEqual(new Date(cancelledAtIso));
    expect(result!.cancelReason).toBe("user requested");
    expect(result!.delayUntil).toEqual(new Date(delayUntilIso));
  });

  it("falls back to entry.envId for runtimeEnvironmentId when snapshot lacks environment.id", async () => {
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
    expect(result!.runtimeEnvironmentId).toBe("env_a");
    expect(result!.workerQueue).toBeUndefined();
    expect(result!.queue).toBeUndefined();
  });

  it("extracts batchId from the nested snapshot.batch object (not the flat key)", async () => {
    // Regression for the field-name mismatch Devin flagged:
    // #buildEngineTriggerInput writes batch info as
    // `batch: { id, index }`, never as a flat `batchId`. readFallback
    // must read the nested key, otherwise SyntheticRun.batchId is always
    // undefined for buffered runs.
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({
        taskIdentifier: "t",
        batch: { id: "batch_internal_xyz", index: 3 },
      }),
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result!.batchId).toBe("batch_internal_xyz");
  });

  it("does NOT read a flat `batchId` key — only the nested batch.id", async () => {
    // Belt-and-braces: a payload with the wrong-shaped flat key should
    // resolve to undefined, not silently pick up the bogus value.
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({
        taskIdentifier: "t",
        batchId: "should-be-ignored",
      }),
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result!.batchId).toBeUndefined();
  });

  it("converts internal parent/root IDs in the snapshot to friendlyIds", async () => {
    // Regression for Devin's structural-unfillable finding: the snapshot
    // only carries INTERNAL parent/root ids (engine.trigger consumes the
    // internal shape), while SyntheticRun exposes friendlyIds. Convert
    // here so consumers don't have to special-case the buffered path.
    // The conversion is deterministic via RunId.toFriendlyId — we drive
    // it through `RunId.generate()` to get a matching internal+friendly
    // pair and assert the round-trip.
    const parent = RunId.generate();
    const root = RunId.generate();
    const entry: BufferEntry = {
      runId: "run_1",
      envId: "env_a",
      orgId: "org_1",
      payload: JSON.stringify({
        taskIdentifier: "t",
        parentTaskRunId: parent.id,
        rootTaskRunId: root.id,
      }),
      status: "QUEUED",
      attempts: 0,
      createdAt: NOW,
    };
    const result = await findRunByIdWithMollifierFallback(
      { runId: "run_1", environmentId: "env_a", organizationId: "org_1" },
      { getBuffer: () => fakeBuffer(entry) },
    );
    expect(result!.parentTaskRunFriendlyId).toBe(parent.friendlyId);
    expect(result!.rootTaskRunFriendlyId).toBe(root.friendlyId);
  });

  it("leaves parent/root friendlyIds undefined when the snapshot carries no parent context", async () => {
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
    expect(result!.parentTaskRunFriendlyId).toBeUndefined();
    expect(result!.rootTaskRunFriendlyId).toBeUndefined();
  });
});
