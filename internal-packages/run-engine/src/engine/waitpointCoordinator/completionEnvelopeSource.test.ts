// The row-to-source mapping the legacy arm depends on. It had no direct coverage: the
// equivalence suite reaches the same code through its `pair()` factory, which proves the
// mapping is self-consistent with the record build but never states what the mapping IS.
import type { Waitpoint } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { envelopeSourceFromWaitpointRow } from "./completionEnvelopeSource.js";

const COMPLETED_AT = new Date("2026-08-25T00:00:00.000Z");

function row(overrides: Partial<Waitpoint> = {}): Waitpoint {
  return {
    id: "wp_1",
    friendlyId: "waitpoint_wp_1",
    type: "MANUAL",
    status: "COMPLETED",
    completedAt: COMPLETED_AT,
    output: null,
    outputType: "application/json",
    outputIsError: false,
    completedByTaskRunId: null,
    completedByBatchId: null,
    completedAfter: null,
    idempotencyKey: "internal",
    userProvidedIdempotencyKey: false,
    inactiveIdempotencyKey: null,
    ...overrides,
  } as unknown as Waitpoint;
}

describe("envelopeSourceFromWaitpointRow", () => {
  it("carries the scalar fields through", () => {
    expect(envelopeSourceFromWaitpointRow(row())).toMatchObject({
      id: "wp_1",
      friendlyId: "waitpoint_wp_1",
      type: "MANUAL",
      completedAt: COMPLETED_AT,
      outputType: "application/json",
      outputIsError: false,
    });
  });

  it("treats a plain output as an inline value", () => {
    const source = envelopeSourceFromWaitpointRow(row({ output: '{"ok":true}' }));

    expect(source.output).toBe('{"ok":true}');
    expect(source.outputRef).toBeUndefined();
  });

  // The type names it, not the shape. A store reference is an opaque string like any other, so
  // reading the string alone cannot tell the two apart.
  it("treats an application/store output as a reference", () => {
    const source = envelopeSourceFromWaitpointRow(
      row({ output: "store-key-1", outputType: "application/store" })
    );

    expect(source.outputRef).toBe("store-key-1");
    expect(source.output).toBeUndefined();
  });

  it("keeps an empty-string output, because empty is a value", () => {
    expect(envelopeSourceFromWaitpointRow(row({ output: "" })).output).toBe("");
  });

  it("omits an absent output entirely", () => {
    const source = envelopeSourceFromWaitpointRow(row());

    expect("output" in source).toBe(false);
    expect("outputRef" in source).toBe(false);
  });

  describe("the idempotency key", () => {
    it("is carried when the user provided it and it is still active", () => {
      const source = envelopeSourceFromWaitpointRow(
        row({ idempotencyKey: "user-key", userProvidedIdempotencyKey: true })
      );

      expect(source.idempotencyKey).toBe("user-key");
    });

    it("is suppressed when the user did not provide it", () => {
      const source = envelopeSourceFromWaitpointRow(
        row({ idempotencyKey: "internal-key", userProvidedIdempotencyKey: false })
      );

      expect(source.idempotencyKey).toBeUndefined();
    });

    it("is suppressed once it goes inactive", () => {
      const source = envelopeSourceFromWaitpointRow(
        row({
          idempotencyKey: "user-key",
          userProvidedIdempotencyKey: true,
          inactiveIdempotencyKey: "rotated",
        })
      );

      expect(source.idempotencyKey).toBeUndefined();
    });
  });

  it("carries the RUN and BATCH back-references", () => {
    expect(
      envelopeSourceFromWaitpointRow(row({ type: "RUN", completedByTaskRunId: "run_child" }))
        .completedByTaskRunId
    ).toBe("run_child");

    expect(
      envelopeSourceFromWaitpointRow(row({ type: "BATCH", completedByBatchId: "batch_1" }))
        .completedByBatchId
    ).toBe("batch_1");
  });

  it("carries completedAfter", () => {
    const completedAfter = new Date("2026-08-26T00:00:00.000Z");

    expect(
      envelopeSourceFromWaitpointRow(row({ type: "DATETIME", completedAfter })).completedAfter
    ).toEqual(completedAfter);
  });

  // A row read at COMPLETED always has this set. The fallback exists so the shape stays total
  // rather than emitting an invalid Date, matching what the snapshot hydration does.
  it("falls back to a real date when completedAt is null", () => {
    expect(envelopeSourceFromWaitpointRow(row({ completedAt: null })).completedAt).toBeInstanceOf(
      Date
    );
  });
});
