import { describe, expect, it } from "vitest";
import type { WaitpointRecordInput } from "./storeCoordinator.js";
import { toPrismaWaitpoint } from "./waitpointShape.js";

const record: WaitpointRecordInput = {
  id: "abcdefghijklmnopqrstuvwxmw",
  friendlyId: "waitpoint_abcdefghijklmnopqrstuvwxmw",
  type: "MANUAL",
  environmentId: "env_1",
  projectId: "proj_1",
  createdAt: "2026-08-26T10:00:00.000Z",
  updatedAt: "2026-08-26T10:00:01.000Z",
  userProvidedIdempotencyKey: true,
  tags: ["alpha", "beta"],
  idempotencyKey: "user-key",
};

describe("toPrismaWaitpoint", () => {
  it("fills every non-null column on a PENDING waitpoint", () => {
    const waitpoint = toPrismaWaitpoint(record, "PENDING");

    expect(waitpoint.id).toBe(record.id);
    expect(waitpoint.friendlyId).toBe(record.friendlyId);
    expect(waitpoint.type).toBe("MANUAL");
    expect(waitpoint.status).toBe("PENDING");
    expect(waitpoint.idempotencyKey).toBe("user-key");
    expect(waitpoint.userProvidedIdempotencyKey).toBe(true);
    expect(waitpoint.projectId).toBe("proj_1");
    expect(waitpoint.environmentId).toBe("env_1");
    expect(waitpoint.tags).toEqual(["alpha", "beta"]);
    expect(waitpoint.createdAt).toEqual(new Date("2026-08-26T10:00:00.000Z"));
    expect(waitpoint.updatedAt).toEqual(new Date("2026-08-26T10:00:01.000Z"));

    // The columns with database defaults, which a consumer reads unconditionally.
    expect(waitpoint.outputType).toBe("application/json");
    expect(waitpoint.outputIsError).toBe(false);

    // Nullable columns that must be null rather than undefined: a consumer distinguishes
    // "no value" from "field missing", and `inactiveIdempotencyKey` is not ported at all.
    expect(waitpoint.completedAt).toBeNull();
    expect(waitpoint.output).toBeNull();
    expect(waitpoint.inactiveIdempotencyKey).toBeNull();
    expect(waitpoint.idempotencyKeyExpiresAt).toBeNull();
    expect(waitpoint.completedByTaskRunId).toBeNull();
    expect(waitpoint.completedByBatchId).toBeNull();
    expect(waitpoint.completedAfter).toBeNull();
  });

  it("carries an inline completion onto a COMPLETED waitpoint", () => {
    const waitpoint = toPrismaWaitpoint(record, "COMPLETED", {
      completedAt: "2026-08-26T11:00:00.000Z",
      outputType: "application/json",
      outputIsError: true,
      output: { inline: '{"boom":true}' },
    });

    expect(waitpoint.status).toBe("COMPLETED");
    expect(waitpoint.completedAt).toEqual(new Date("2026-08-26T11:00:00.000Z"));
    expect(waitpoint.output).toBe('{"boom":true}');
    expect(waitpoint.outputType).toBe("application/json");
    expect(waitpoint.outputIsError).toBe(true);
  });

  it("carries an offloaded reference in the output column, as the legacy row does", () => {
    const waitpoint = toPrismaWaitpoint(record, "COMPLETED", {
      completedAt: "2026-08-26T11:00:00.000Z",
      outputType: "application/store",
      outputIsError: false,
      output: { ref: "waitpoints/abc/output.json" },
    });

    expect(waitpoint.output).toBe("waitpoints/abc/output.json");
    expect(waitpoint.outputType).toBe("application/store");
  });

  it("leaves output null when the completion carries none", () => {
    // A BATCH completion, and the deriveFromRun case: the value is re-derived at read
    // time and is never copied onto the row.
    const waitpoint = toPrismaWaitpoint({ ...record, type: "BATCH" }, "COMPLETED", {
      completedAt: "2026-08-26T11:00:00.000Z",
      outputType: "application/json",
      outputIsError: false,
      output: null,
    });

    expect(waitpoint.status).toBe("COMPLETED");
    expect(waitpoint.output).toBeNull();
  });

  it("maps the optional anchor and timing columns when the record carries them", () => {
    const waitpoint = toPrismaWaitpoint(
      {
        ...record,
        type: "RUN",
        completedByTaskRunId: "run_1",
        completedByBatchId: "batch_1",
        completedAfter: "2026-08-27T00:00:00.000Z",
        idempotencyKeyExpiresAt: "2026-08-28T00:00:00.000Z",
      },
      "PENDING"
    );

    expect(waitpoint.completedByTaskRunId).toBe("run_1");
    expect(waitpoint.completedByBatchId).toBe("batch_1");
    expect(waitpoint.completedAfter).toEqual(new Date("2026-08-27T00:00:00.000Z"));
    expect(waitpoint.idempotencyKeyExpiresAt).toEqual(new Date("2026-08-28T00:00:00.000Z"));
  });

  it("throws when the record carries no idempotency key", () => {
    // The column is non-null and participates in the (environmentId, idempotencyKey)
    // unique index, so inventing a value here could collide. The arm always mints one;
    // an absent key means the arm has a defect, and it must surface as one.
    const { idempotencyKey, ...withoutKey } = record;

    expect(() => toPrismaWaitpoint(withoutKey, "PENDING")).toThrow(/idempotency key/i);
  });
});
