import { describe, expect, it } from "vitest";
import { OutputPayload } from "../run-queue/types.js";
import { createTtlWorkerCatalog } from "./ttlWorkerCatalog.js";
import { workerCatalog } from "./workerCatalog.js";

const snapshotRoute = { version: 99, opaque: { storage: "future" } };

const runPayload = {
  runId: "run_123",
  orgId: "org_123",
  projectId: "proj_123",
  environmentId: "env_123",
  environmentType: "PRODUCTION",
  queue: "task/example",
  timestamp: 1_700_000_000_000,
  attempt: 0,
  snapshotRoute,
};

describe("worker payload validation", () => {
  it.each([
    { version: "1", masterQueues: ["master"] },
    { version: "2", workerQueue: "worker" },
  ])("preserves opaque snapshot routes in queue version $version", (version) => {
    const input = { ...runPayload, ...version };

    expect(OutputPayload.parse({ ...input, extra: "stripped" })).toEqual(input);
  });

  it("reports invalid queue fields without rejecting opaque snapshot routes", () => {
    const result = OutputPayload.safeParse({
      ...runPayload,
      version: "2",
      workerQueue: "worker",
      attempt: "invalid",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toEqual([
        expect.objectContaining({ code: "invalid_type", path: ["attempt"] }),
      ]);
    }
  });

  it("coerces cancellation dates and rejects invalid dates", () => {
    const input = {
      runId: "run_123",
      completedAt: "2026-01-01T00:00:00.000Z",
      snapshotRoute,
    };

    expect(workerCatalog.cancelRun.schema.parse(input)).toEqual({
      ...input,
      completedAt: new Date(input.completedAt),
    });
    expect(
      workerCatalog.cancelRun.schema.safeParse({ ...input, completedAt: "invalid" }).success
    ).toBe(false);
  });

  it("preserves opaque snapshot routes for TTL jobs", () => {
    const catalog = createTtlWorkerCatalog({ batchMaxSize: 10 });
    const input = { runId: "run_123", orgId: "org_123", queueKey: "queue", snapshotRoute };

    expect(catalog.expireTtlRun.schema.parse(input)).toEqual(input);
    expect(catalog.expireTtlRun.schema.safeParse({ ...input, runId: 123 }).success).toBe(false);
  });
});
