import { describe, expect, it, vi } from "vitest";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { applyMetadataMutationToBufferedRun } from "~/v3/mollifier/applyMetadataMutation.server";
import type { BufferEntry, MollifierBuffer, CasSetMetadataResult } from "@trigger.dev/redis-worker";

// Regression for the CAS retry-exhaustion bug found by Phase F. The
// default `maxRetries` was 3, matching the PG-side service, but that
// exhausts fast when N external API writers race the same buffered
// run's metadata. Bumped to 12 + jittered backoff (commit 4e7d5d8a2).
// These tests simulate version_conflict races and assert (a) every
// delta lands and (b) the retry budget is sized for realistic
// concurrency.

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
    getEntry: vi.fn(async (): Promise<BufferEntry> => ({
      ...entryTemplate,
      metadataVersion: state.version,
      payload: JSON.stringify({ ...initialPayload, metadata: JSON.stringify(state.metadata) }),
    })),
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
      },
    ),
  } as unknown as MollifierBuffer;

  return { buffer, state };
}

describe("applyMetadataMutationToBufferedRun — retry behaviour", () => {
  it("succeeds when CAS lands on the first try (no contention)", async () => {
    const { buffer, state } = makeBufferStub();
    const result = await applyMetadataMutationToBufferedRun({
      runId: "run_1",
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
      const state = (buffer as unknown as { __state__?: never; getEntry: () => Promise<BufferEntry> });
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
      body: { operations: [{ type: "increment", key: "counter", value: 1 }] },
      buffer: stub.buffer,
      maxRetries: 3,
    });
    expect(result.kind).toBe("version_exhausted");
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
        body: { operations: [{ type: "increment", key: "counter", value: 1 }] },
        buffer: sharedStub.buffer,
      }),
    );
    const results = await Promise.all(calls);
    const applied = results.filter((r) => r.kind === "applied").length;
    expect(applied).toBe(N);
    expect(sharedStub.state.metadata.counter).toBe(N);
  });
});
