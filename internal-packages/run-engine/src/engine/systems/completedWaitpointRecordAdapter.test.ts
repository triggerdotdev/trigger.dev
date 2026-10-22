// Pure mapping coverage; storage routing and failures use real stores in the integration suite.
import { describe, expect, it } from "vitest";
import { generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type {
  WaitpointCompletion,
  WaitpointRecordInput,
  WaitpointStoredRecord,
} from "../waitpointCoordinator/storeCoordinator.js";
import { storeRecordToCompletedWaitpointRecord } from "./completedWaitpointRecordAdapter.js";

function storeRecordInput(
  id: string,
  overrides: Partial<WaitpointRecordInput> = {}
): WaitpointRecordInput {
  return {
    id,
    friendlyId: `waitpoint_${id}`,
    type: "MANUAL",
    environmentId: "env_1",
    projectId: "proj_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    userProvidedIdempotencyKey: false,
    tags: [],
    ...overrides,
  };
}

function storeCompletion(overrides: Partial<WaitpointCompletion> = {}): WaitpointCompletion {
  return {
    completedAt: "2026-01-01T00:00:00.000Z",
    outputType: "application/json",
    outputIsError: false,
    output: null,
    ...overrides,
  };
}

function storeEntry(
  id: string,
  recordOverrides: Partial<WaitpointRecordInput> = {},
  completion: WaitpointCompletion | undefined = storeCompletion(),
  status: WaitpointStoredRecord["status"] = "COMPLETED"
): WaitpointStoredRecord {
  return { status, record: storeRecordInput(id, recordOverrides), completion };
}

// A fixed effective time for the mapping tests that do not exercise expiry.
const NOW_MS = Date.parse("2026-08-21T12:00:00.000Z");
const mapStoreRecord = (entry: WaitpointStoredRecord, nowMs: number = NOW_MS) =>
  storeRecordToCompletedWaitpointRecord(entry, nowMs);

describe("storeRecordToCompletedWaitpointRecord — envelope fidelity", () => {
  it("preserves an inline output", () => {
    const id = generateWaitpointId("MANUAL");
    const record = mapStoreRecord(
      storeEntry(id, {}, storeCompletion({ output: { inline: '{"value":42}' } }))
    );
    expect(record.output).toEqual({ inline: '{"value":42}' });
  });

  it("preserves a referenced (offloaded) output", () => {
    const id = generateWaitpointId("MANUAL");
    const record = mapStoreRecord(
      storeEntry(
        id,
        {},
        storeCompletion({ outputType: "application/store", output: { ref: "s3://bucket/key" } })
      )
    );
    expect(record.output).toEqual({ ref: "s3://bucket/key" });
    expect(record.outputType).toBe("application/store");
  });

  it("preserves an error output and its flag", () => {
    const id = generateWaitpointId("MANUAL");
    const record = mapStoreRecord(
      storeEntry(
        id,
        {},
        storeCompletion({ outputIsError: true, output: { inline: '{"type":"STRING_ERROR"}' } })
      )
    );
    expect(record.outputIsError).toBe(true);
    expect(record.output).toEqual({ inline: '{"type":"STRING_ERROR"}' });
  });

  it("keeps a RUN success on deriveFromRun, not a copy of its output", () => {
    const id = generateWaitpointId("RUN");
    const record = mapStoreRecord(
      storeEntry(
        id,
        { type: "RUN", completedByTaskRunId: "run_child" },
        storeCompletion({ output: { inline: '{"value":42}' } })
      )
    );
    // The stored inline value is dropped: the read side re-derives it from TaskRun.output.
    expect(record.output).toEqual({ deriveFromRun: true });
    expect(record.completedByTaskRunId).toBe("run_child");
  });

  it("keeps a RUN success on deriveFromRun even when the stored output is null", () => {
    // The store may keep a re-derivable RUN success's output null rather than copy it. That null must
    // still resolve to deriveFromRun, NOT to no output — the completion is re-read from TaskRun.output.
    const id = generateWaitpointId("RUN");
    const record = mapStoreRecord(
      storeEntry(
        id,
        { type: "RUN", completedByTaskRunId: "run_child" },
        storeCompletion({ output: null })
      )
    );
    expect(record.output).toEqual({ deriveFromRun: true });
    expect(record.completedByTaskRunId).toBe("run_child");
  });

  it("carries a RUN ERROR inline, never deriveFromRun", () => {
    const id = generateWaitpointId("RUN");
    const record = mapStoreRecord(
      storeEntry(
        id,
        { type: "RUN", completedByTaskRunId: "run_child" },
        storeCompletion({ outputIsError: true, output: { inline: '{"type":"BUILT_IN_ERROR"}' } })
      )
    );
    expect(record.output).toEqual({ inline: '{"type":"BUILT_IN_ERROR"}' });
  });

  it("preserves timestamps and type-specific metadata", () => {
    const id = generateWaitpointId("DATETIME");
    const record = mapStoreRecord(
      storeEntry(
        id,
        { type: "DATETIME", completedAfter: "2026-02-02T00:00:00.000Z" },
        storeCompletion({ completedAt: "2026-03-03T04:05:06.000Z" })
      )
    );
    expect(record.type).toBe("DATETIME");
    expect(record.completedAt).toBe("2026-03-03T04:05:06.000Z");
    expect(record.completedAfter).toBe("2026-02-02T00:00:00.000Z");
  });

  it("exposes a user-provided idempotency key and hides a system one", () => {
    const id = generateWaitpointId("MANUAL");
    const withUserKey = mapStoreRecord(
      storeEntry(id, { userProvidedIdempotencyKey: true, idempotencyKey: "idem_user" })
    );
    expect(withUserKey.idempotencyKey).toBe("idem_user");

    const withSystemKey = mapStoreRecord(
      storeEntry(id, { userProvidedIdempotencyKey: false, idempotencyKey: "idem_system" })
    );
    expect(withSystemKey.idempotencyKey).toBeUndefined();
  });
});

describe("storeRecordToCompletedWaitpointRecord — idempotency key expiry", () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const userKey = (overrides: Partial<WaitpointRecordInput>) =>
    storeEntry(generateWaitpointId("MANUAL"), {
      userProvidedIdempotencyKey: true,
      idempotencyKey: "idem_user",
      ...overrides,
    });

  it("keeps a user key with no expiry visible", () => {
    expect(mapStoreRecord(userKey({}), NOW_MS).idempotencyKey).toBe("idem_user");
  });

  it("keeps a user key with a future expiry visible", () => {
    const record = mapStoreRecord(
      userKey({ idempotencyKeyExpiresAt: iso(NOW_MS + 60_000) }),
      NOW_MS
    );
    expect(record.idempotencyKey).toBe("idem_user");
  });

  it("omits a user key with a past expiry", () => {
    const record = mapStoreRecord(
      userKey({ idempotencyKeyExpiresAt: iso(NOW_MS - 60_000) }),
      NOW_MS
    );
    expect(record.idempotencyKey).toBeUndefined();
  });

  it("omits a user key expiring exactly at the effective time (PEXPIREAT semantics)", () => {
    const record = mapStoreRecord(userKey({ idempotencyKeyExpiresAt: iso(NOW_MS) }), NOW_MS);
    expect(record.idempotencyKey).toBeUndefined();
  });

  it("fails loud on a malformed stored expiry", () => {
    expect(() =>
      mapStoreRecord(userKey({ idempotencyKeyExpiresAt: "not-a-date" }), NOW_MS)
    ).toThrow(/malformed idempotencyKeyExpiresAt/);
  });

  it("keeps a system-generated key hidden regardless of expiry (never throws on its expiry)", () => {
    const system = (expiry: string | undefined) =>
      storeEntry(generateWaitpointId("MANUAL"), {
        userProvidedIdempotencyKey: false,
        idempotencyKey: "idem_system",
        idempotencyKeyExpiresAt: expiry,
      });
    expect(mapStoreRecord(system(iso(NOW_MS - 60_000)), NOW_MS).idempotencyKey).toBeUndefined();
    expect(mapStoreRecord(system(iso(NOW_MS + 60_000)), NOW_MS).idempotencyKey).toBeUndefined();
    // A malformed expiry on a hidden key is never consulted, so it does not fail loud.
    expect(mapStoreRecord(system("not-a-date"), NOW_MS).idempotencyKey).toBeUndefined();
  });
});
