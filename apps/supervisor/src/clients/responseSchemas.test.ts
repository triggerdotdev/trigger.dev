import { WorkerApiRunLatestSnapshotResponseBody } from "@trigger.dev/core/v3/workers";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveResponseSchema } from "./responseSchemas.js";

describe("supervisor response schemas", () => {
  it("retains date normalization and validation errors for snapshots", () => {
    const schema = resolveResponseSchema(WorkerApiRunLatestSnapshotResponseBody);
    const result = schema.parse({
      execution: {
        version: "1",
        snapshot: {
          id: "snapshot_1",
          friendlyId: "snap_1",
          executionStatus: "EXECUTING",
          description: "Run is executing",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        run: { id: "run_1", friendlyId: "run_1", status: "EXECUTING" },
        completedWaitpoints: [],
      },
    });

    expect(result.execution.snapshot.createdAt).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(schema.safeParse({ execution: {} }).success).toBe(false);
  });

  it("does not compile unfamiliar schemas or repeat their callbacks", () => {
    let calls = 0;
    const schema = z.string().refine(() => ++calls > 1);

    expect(resolveResponseSchema(schema).safeParse("value").success).toBe(false);
    expect(calls).toBe(1);
  });
});
