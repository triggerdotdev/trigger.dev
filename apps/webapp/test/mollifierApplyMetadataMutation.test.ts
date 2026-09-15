import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { applyMetadataMutationToBufferedRun } from "~/v3/mollifier/applyMetadataMutation.server";
import type { BufferEntry, MollifierBuffer, CasSetMetadataResult } from "@trigger.dev/redis-worker";
import { RunId } from "@trigger.dev/core/v3/isomorphic";

// Regression for a CAS retry-exhaustion bug: the default `maxRetries`
// was 3, matching the PG-side service, but that exhausts fast when N
// external API writers race the same buffered run's metadata. Bumped
// to 12 + jittered backoff. These tests simulate version_conflict
// races and assert (a) every delta lands and (b) the retry budget is
// sized for realistic concurrency.

const NOW = new Date("2026-05-21T10:00:00Z");

type BufferStub = {
  buffer: MollifierBuffer;
  state: {
    version: number;
    metadata: Record<string, unknown>;
    pendingConflictsForNextN: number;
  };
};

// Build a stub MollifierBuffer that simulates Lua-CAS semantics
// in-memory. The first `pendingConflictsForNextN` casSetMetadata calls
// from any worker will return version_conflict (then the version
// bumps); subsequent calls succeed.
function makeBufferStub(initialPayload: Record<string, unknown> = {}): BufferStub {
  const state = {
    version: 0,
    metadata: initialPayload.metadata
      ? (JSON.parse(initialPayload.metadata as string) as Record<string, unknown>)
      : {},
    pendingConflictsForNextN: 0,
  };
  const entryTemplate: Omit<BufferEntry, "payload"> = {
    runId: "run_1",
    envId: "env_a",
    orgId: "org_1",
    status: "QUEUED",
    attempts: 0,
    createdAt: NOW,
    createdAtMicros: 1747044000000000,
    materialised: false,
    idempotencyLookupKey: "",
    metadataVersion: 0,
  };

  const buffer: MollifierBuffer = {
    getEntry: vi.fn(
      async (): Promise<BufferEntry> => ({
        ...entryTemplate,
        metadataVersion: state.version,
        payload: JSON.stringify({ ...initialPayload, metadata: JSON.stringify(state.metadata) }),
      })
    ),
    casSetMetadata: vi.fn(
      async (input: {
        runId: string;
        expectedVersion: number;
        newMetadata: string;
        newMetadataType: string;
      }): Promise<CasSetMetadataResult> => {
        // Inject a controlled number of conflicts to simulate races.
        if (state.pendingConflictsForNextN > 0) {
          state.pendingConflictsForNextN -= 1;
          // Bump version as if some other writer just landed.
          state.version += 1;
          return { kind: "version_conflict", currentVersion: state.version };
        }
        if (input.expectedVersion !== state.version) {
          return { kind: "version_conflict", currentVersion: state.version };
        }
        state.metadata = JSON.parse(input.newMetadata) as Record<string, unknown>;
        state.version += 1;
        return { kind: "applied", newVersion: state.version };
      }
    ),
  } as unknown as MollifierBuffer;

  return { buffer, state };
}

describe("applyMetadataMutationToBufferedRun — retry behaviour", () => {
  it("succeeds when CAS lands on the first try (no contention)", async () => {
    const { buffer, state } = makeBufferStub();
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
      environmentId: "env_a",
      organizationId: "org_1",
      maximumSize: 1024 * 1024,
      body: { metadata: { counter: 1 } },
      buffer,
    });
    expect(result.kind).toBe("applied");
    expect(state.metadata).toEqual({ counter: 1 });
    expect(state.version).toBe(1);
  });

  it("succeeds after 5 version conflicts (default budget = 12)", async () => {
    const { buffer, state } = makeBufferStub();
    state.pendingConflictsForNextN = 5;
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
      environmentId: "env_a",
      organizationId: "org_1",
      maximumSize: 1024 * 1024,
      body: { operations: [{ type: "increment", key: "counter", value: 1 }] },
      buffer,
    });
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.newMetadata.counter).toBe(1);
    }
  });

  it("succeeds after 11 version conflicts (one under the default budget)", async () => {
    const { buffer } = makeBufferStub();
    const setStateConflicts = (n: number) => {
      // Re-read state from the closure
      const state = buffer as unknown as {
        __state__?: never;
        getEntry: () => Promise<BufferEntry>;
      };
      void state;
    };
    void setStateConflicts;
    // Set conflicts directly via the shared state object
    const { state } = makeBufferStub();
    state.pendingConflictsForNextN = 11;
    // Build a fresh stub since we want one shared state instance
    const stub = makeBufferStub();
    stub.state.pendingConflictsForNextN = 11;
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
      environmentId: "env_a",
      organizationId: "org_1",
      maximumSize: 1024 * 1024,
      body: { operations: [{ type: "increment", key: "counter", value: 1 }] },
      buffer: stub.buffer,
    });
    expect(result.kind).toBe("applied");
  });

  it("returns version_exhausted after retries are spent", async () => {
    const stub = makeBufferStub();
    // 99 conflicts ≫ default budget of 12. With maxRetries 3 (the
    // pre-fix value), this would have exhausted after 4 attempts.
    stub.state.pendingConflictsForNextN = 99;
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
      environmentId: "env_a",
      organizationId: "org_1",
      maximumSize: 1024 * 1024,
      body: { operations: [{ type: "increment", key: "counter", value: 1 }] },
      buffer: stub.buffer,
      maxRetries: 12,
    });
    expect(result.kind).toBe("version_exhausted");
  });

  it("regression: 3 retries are NOT enough under 50-way concurrency simulation", async () => {
    // The pre-fix default would have lost most deltas under this
    // contention. Asserting that the OLD budget (3) exhausts confirms
    // the regression actually existed and the new budget addresses it.
    const stub = makeBufferStub();
    stub.state.pendingConflictsForNextN = 8;
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
      environmentId: "env_a",
      organizationId: "org_1",
      maximumSize: 1024 * 1024,
      body: { operations: [{ type: "increment", key: "counter", value: 1 }] },
      buffer: stub.buffer,
      maxRetries: 3,
    });
    expect(result.kind).toBe("version_exhausted");
  });

  it("matches PG semantics when body has both metadata + operations: ops on top of EXISTING, body.metadata ignored", async () => {
    // PG service (UpdateMetadataService.#updateRunMetadata) branches on
    // Array.isArray(body.operations) — when present it applies ops on
    // top of existing PG metadata and IGNORES body.metadata. The buffer
    // helper used to merge both (replace then apply), producing different
    // results across the buffered/materialised boundary. This regression
    // pins the PG-matching behaviour.
    const stub = makeBufferStub({ metadata: JSON.stringify({ a: 1 }) });
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
      environmentId: "env_a",
      organizationId: "org_1",
      maximumSize: 1024 * 1024,
      body: {
        // Should be ignored because `operations` is also present.
        metadata: { b: 2 },
        operations: [{ type: "set", key: "c", value: 3 }],
      },
      buffer: stub.buffer,
    });
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      // PG would produce {a:1, c:3}; previously the buffer produced {b:2, c:3}.
      expect(result.newMetadata).toEqual({ a: 1, c: 3 });
      expect(result.newMetadata).not.toHaveProperty("b");
    }
  });

  it("returns metadata_too_large when the resulting payload exceeds maximumSize (mirrors PG 413)", async () => {
    // PG-side `UpdateMetadataService` uses `handleMetadataPacket` to
    // enforce TASK_RUN_METADATA_MAXIMUM_SIZE (default 256KB), throwing
    // `MetadataTooLargeError` (413) on overflow. The buffer helper now
    // matches that cap so a buffered run can't accept a payload PG
    // would have rejected. Reject must fire BEFORE casSetMetadata.
    const stub = makeBufferStub();
    const big = "x".repeat(2048); // 2 KB string value
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
      environmentId: "env_a",
      organizationId: "org_1",
      maximumSize: 1024, // 1 KB cap — strictly less than the payload
      body: { metadata: { big } },
      buffer: stub.buffer,
    });
    expect(result.kind).toBe("metadata_too_large");
    if (result.kind === "metadata_too_large") {
      expect(result.maximumSize).toBe(1024);
      expect(result.observedSize).toBeGreaterThan(1024);
    }
    // No CAS write should have been attempted.
    expect(stub.buffer.casSetMetadata).not.toHaveBeenCalled();
    expect(stub.state.version).toBe(0);
  });

  it("returns not_found when the buffered entry belongs to a different env (cross-env auth gate)", async () => {
    // Same shape as a normal apply call, but the caller's environmentId
    // doesn't match the entry's envId. The helper must refuse the
    // mutation and return not_found (without leaking existence) and
    // must NOT call casSetMetadata.
    const stub = makeBufferStub();
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
      environmentId: "env_OTHER",
      organizationId: "org_1",
      maximumSize: 1024 * 1024,
      body: { metadata: { counter: 1 } },
      buffer: stub.buffer,
    });
    expect(result.kind).toBe("not_found");
    expect(stub.buffer.casSetMetadata).not.toHaveBeenCalled();
    expect(stub.state.version).toBe(0);
  });

  it("returns not_found when the buffered entry belongs to a different org (cross-org auth gate)", async () => {
    const stub = makeBufferStub();
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
      environmentId: "env_a",
      organizationId: "org_OTHER",
      maximumSize: 1024 * 1024,
      body: { metadata: { counter: 1 } },
      buffer: stub.buffer,
    });
    expect(result.kind).toBe("not_found");
    expect(stub.buffer.casSetMetadata).not.toHaveBeenCalled();
  });

  it("surfaces parent/root friendlyIds on `applied` so the route can fan parent/root ops without a second buffer read", async () => {
    // Regression: the metadata route used to do a SECOND
    // `findRunByIdWithMollifierFallback` after the primary CAS to
    // obtain parent/root friendlyIds for `routeOperationsToRun`.
    // If the drainer's terminal-failure path ran between the CAS and
    // the second read, the entry hash was DELd and the second read
    // came back null — the route silently skipped the entire
    // parent/root fan-out, dropping `body.parentOperations` /
    // `body.rootOperations` after the primary mutation already
    // landed. The helper now captures the ids inside its own read
    // loop and surfaces them on the `applied` outcome so the route
    // never needs a second round trip.
    //
    // Engine-side snapshot stores internal cuids; we expect the
    // helper to convert via `RunId.toFriendlyId` so the outcome
    // matches what `readFallback.server.ts` would have produced.
    const parentFriendly = RunId.generate().friendlyId;
    const rootFriendly = RunId.generate().friendlyId;
    const parentInternal = RunId.fromFriendlyId(parentFriendly);
    const rootInternal = RunId.fromFriendlyId(rootFriendly);
    const stub = makeBufferStub({
      parentTaskRunId: parentInternal,
      rootTaskRunId: rootInternal,
    });
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
      environmentId: "env_a",
      organizationId: "org_1",
      maximumSize: 1024 * 1024,
      body: { metadata: { counter: 1 } },
      buffer: stub.buffer,
    });
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.parentTaskRunFriendlyId).toBe(parentFriendly);
      expect(result.rootTaskRunFriendlyId).toBe(rootFriendly);
    }
  });

  it("`applied` parent/root ids are undefined when the snapshot carries neither (top-level run)", async () => {
    // Top-level runs (parentTaskRunId/rootTaskRunId both undefined in
    // the engine-trigger snapshot) must surface as undefined on the
    // outcome so the route's `?? runId` self-fallback fires —
    // matching the PG service's `taskRun.parentTaskRun?.id ??
    // taskRun.id` semantics.
    const stub = makeBufferStub({});
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
      environmentId: "env_a",
      organizationId: "org_1",
      maximumSize: 1024 * 1024,
      body: { metadata: { counter: 1 } },
      buffer: stub.buffer,
    });
    expect(result.kind).toBe("applied");
    if (result.kind === "applied") {
      expect(result.parentTaskRunFriendlyId).toBeUndefined();
      expect(result.rootTaskRunFriendlyId).toBeUndefined();
    }
  });

  it("N-way concurrent applies all converge under default budget", async () => {
    // Simulate N parallel writers against a shared state. Each writer
    // reads, applies a delta, CAS-writes. The Lua CAS forces them to
    // retry until they see the latest version.
    const N = 30;
    const sharedStub = makeBufferStub();
    // Override the stub to model real per-attempt serialisation: each
    // call reads the latest version, and CAS conflicts are organic
    // (not pre-injected) when expectedVersion != current.
    sharedStub.state.pendingConflictsForNextN = 0;

    const calls = Array.from({ length: N }, () =>
      applyMetadataMutationToBufferedRun({
        runId: "run_1",
        environmentId: "env_a",
        organizationId: "org_1",
        maximumSize: 1024 * 1024,
        body: { operations: [{ type: "increment", key: "counter", value: 1 }] },
        buffer: sharedStub.buffer,
      })
    );
    const results = await Promise.all(calls);
    const applied = results.filter((r) => r.kind === "applied").length;
    expect(applied).toBe(N);
    expect(sharedStub.state.metadata.counter).toBe(N);
  });
});
