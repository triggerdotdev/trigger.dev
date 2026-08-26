import { describe, expect, it } from "vitest";
import { buildCompletedWaitpointRecords } from "./completedWaitpointRecords.js";
import type { CompletionEnvelopeSource } from "./types.js";

const COMPLETED_AT = new Date("2026-08-25T00:00:00.000Z");

function source(overrides: Partial<CompletionEnvelopeSource> = {}): CompletionEnvelopeSource {
  return {
    id: "wp_1",
    friendlyId: "waitpoint_wp_1",
    type: "MANUAL",
    completedAt: COMPLETED_AT,
    outputType: "application/json",
    outputIsError: false,
    ...overrides,
  };
}

describe("buildCompletedWaitpointRecords", () => {
  it("emits one record per distinct id", () => {
    const records = buildCompletedWaitpointRecords([source(), source()]);

    expect(records).toHaveLength(1);
  });

  it("emits one record for each of several distinct ids", () => {
    const records = buildCompletedWaitpointRecords([
      source({ id: "wp_1" }),
      source({ id: "wp_2" }),
    ]);

    expect(records.map((r) => r.id)).toEqual(["wp_1", "wp_2"]);
  });

  it("writes completedAt as an ISO string", () => {
    const [record] = buildCompletedWaitpointRecords([source()]);

    expect(record?.completedAt).toBe("2026-08-25T00:00:00.000Z");
  });

  it("omits every absent optional field rather than writing undefined", () => {
    const [record] = buildCompletedWaitpointRecords([source()]);

    expect("completedByTaskRunId" in record!).toBe(false);
    expect("completedByBatchId" in record!).toBe(false);
    expect("completedAfter" in record!).toBe(false);
    expect("idempotencyKey" in record!).toBe(false);
  });

  it("carries the fields the executor shape needs", () => {
    const [record] = buildCompletedWaitpointRecords([
      source({
        completedAfter: new Date("2026-08-26T00:00:00.000Z"),
        idempotencyKey: "user-key",
      }),
    ]);

    expect(record).toMatchObject({
      id: "wp_1",
      friendlyId: "waitpoint_wp_1",
      type: "MANUAL",
      outputType: "application/json",
      outputIsError: false,
      completedAfter: "2026-08-26T00:00:00.000Z",
      idempotencyKey: "user-key",
    });
  });

  describe("the output variant", () => {
    it("keeps an already-offloaded value as a ref", () => {
      const [record] = buildCompletedWaitpointRecords([
        source({ outputRef: "store-key-1", outputType: "application/store" }),
      ]);

      expect(record?.output).toEqual({ ref: "store-key-1" });
    });

    it("prefers a ref over an inline value when both are somehow present", () => {
      const [record] = buildCompletedWaitpointRecords([
        source({ output: '{"ok":true}', outputRef: "store-key-1" }),
      ]);

      expect(record?.output).toEqual({ ref: "store-key-1" });
    });

    // Deliberately a ref, not deriveFromRun, and the opposite of the reference implementation in
    // completedWaitpointFreeze.test.ts. Byte-identical either way, and this route stays
    // resolvable when the completing run row is gone.
    it("routes an offloaded RUN success down the ref branch", () => {
      const [record] = buildCompletedWaitpointRecords([
        source({
          type: "RUN",
          outputRef: "s3://bucket/key",
          outputType: "application/store",
          completedByTaskRunId: "run_1",
        }),
      ]);

      expect(record?.output).toEqual({ ref: "s3://bucket/key" });
    });

    it("marks a plain RUN output as derivable from the run", () => {
      const [record] = buildCompletedWaitpointRecords([
        source({ type: "RUN", output: '{"ok":true}', completedByTaskRunId: "run_1" }),
      ]);

      expect(record?.output).toEqual({ deriveFromRun: true });
    });

    // TaskRun.error is jsonb and does not round-trip to the same string, so a RUN error can
    // never be re-read from the run row.
    it("keeps a RUN error inline", () => {
      const [record] = buildCompletedWaitpointRecords([
        source({
          type: "RUN",
          output: '{"message":"boom"}',
          outputIsError: true,
          completedByTaskRunId: "run_1",
        }),
      ]);

      expect(record?.output).toEqual({ inline: '{"message":"boom"}' });
    });

    // The back-reference is onDelete: SetNull, so an orphaned RUN waitpoint has no run row
    // left to derive from.
    it("keeps an orphaned RUN inline", () => {
      const [record] = buildCompletedWaitpointRecords([
        source({ type: "RUN", output: '{"ok":true}' }),
      ]);

      expect(record?.output).toEqual({ inline: '{"ok":true}' });
    });

    it("omits a BATCH output, because the runtime discards it at source", () => {
      const [record] = buildCompletedWaitpointRecords([
        source({ type: "BATCH", completedByBatchId: "batch_1", output: '{"ignored":true}' }),
      ]);

      expect(record?.output).toBeNull();
    });

    it("keeps a MANUAL output inline", () => {
      const [record] = buildCompletedWaitpointRecords([source({ output: '{"token":1}' })]);

      expect(record?.output).toEqual({ inline: '{"token":1}' });
    });

    it("keeps a DATETIME output inline", () => {
      const [record] = buildCompletedWaitpointRecords([
        source({ type: "DATETIME", output: '{"at":1}' }),
      ]);

      expect(record?.output).toEqual({ inline: '{"at":1}' });
    });

    it("writes null when there is no output at all", () => {
      const [record] = buildCompletedWaitpointRecords([source()]);

      expect(record?.output).toBeNull();
    });

    it("keeps an empty-string output inline, because empty is a value and not an absence", () => {
      const [record] = buildCompletedWaitpointRecords([source({ output: "" })]);

      expect(record?.output).toEqual({ inline: "" });
    });
  });

  it("returns an empty set for no sources", () => {
    expect(buildCompletedWaitpointRecords([])).toEqual([]);
  });
});
