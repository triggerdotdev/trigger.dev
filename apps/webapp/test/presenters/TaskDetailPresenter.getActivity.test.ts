// SPLIT-NEUTRAL VERIFICATION: getActivity reads ClickHouse
// (task_runs_v2) ONLY and never touches the run-ops Prisma client. A
// heterogeneous legacy/new Postgres fixture is deliberately not applicable
// here — there is no run-ops Postgres read to validate cross-version. The
// throwing Proxy passed as `replica` proves it: any access throws.

import { describe, expect, vi } from "vitest";
import { clickhouseTest } from "@internal/testcontainers";
import { ClickHouse, type TaskRunV2 } from "@internal/clickhouse";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TaskDetailPresenter } from "~/presenters/v3/TaskDetailPresenter.server";

vi.setConfig({ testTimeout: 60_000 });

const organizationId = "org_activity_test";
const projectId = "project_activity_test";
const environmentId = "env_activity_test";
const taskSlug = "my-activity-task";

function makeRun(overrides: Partial<TaskRunV2>): TaskRunV2 {
  const createdAt = overrides.created_at ?? Date.now();
  return {
    environment_id: environmentId,
    organization_id: organizationId,
    project_id: projectId,
    run_id: `run_${randomUUID()}`,
    friendly_id: `friendly_${randomUUID()}`,
    updated_at: createdAt,
    created_at: createdAt,
    status: "COMPLETED_SUCCESSFULLY",
    environment_type: "PRODUCTION",
    attempt: 1,
    engine: "V2",
    task_identifier: taskSlug,
    queue: "my-queue",
    schedule_id: "",
    batch_id: "",
    task_version: "",
    sdk_version: "",
    cli_version: "",
    machine_preset: "",
    root_run_id: "",
    parent_run_id: "",
    span_id: "",
    trace_id: "",
    idempotency_key: "",
    expiration_ttl: "",
    _version: "1",
    _is_deleted: 0,
    ...overrides,
  };
}

describe("TaskDetailPresenter.getActivity (ClickHouse-only)", () => {
  clickhouseTest(
    "buckets task_runs_v2 activity by status group, excludes deleted, never reads Postgres",
    async ({ clickhouseContainer }) => {
      const clickhouse = new ClickHouse({
        url: clickhouseContainer.getConnectionUrl(),
        name: "task-detail-activity-test",
        compression: { request: true },
      });

      const insert = clickhouse.writer.insert({
        name: "insertTaskRunsActivityTest",
        table: "trigger_dev.task_runs_v2",
        schema: z.any(),
        settings: { async_insert: 0, enable_json_type: 1, type_json_skip_duplicated_paths: 1 },
      });

      // 6h window => 300s (5-minute) buckets => 72 buckets (chooseBucketSeconds targets ~72).
      const from = new Date("2026-01-01T00:00:00Z");
      const to = new Date("2026-01-01T06:00:00Z");
      const BUCKET_MS = 5 * 60 * 1000;

      // 00:30 bucket: 1 COMPLETED, 1 FAILED (+ 1 deleted, excluded).
      // 02:30 bucket: 1 CANCELED, RUNNING = EXECUTING + unknown-status = 2.
      const bucket0 = new Date("2026-01-01T00:30:00Z").getTime();
      const bucket2 = new Date("2026-01-01T02:30:00Z").getTime();

      const rows = [
        makeRun({ created_at: bucket0, status: "COMPLETED_SUCCESSFULLY" }),
        makeRun({ created_at: bucket0, status: "CRASHED" }), // FAILED group
        makeRun({ created_at: bucket2, status: "CANCELED" }), // CANCELED group
        makeRun({ created_at: bucket2, status: "EXECUTING" }), // RUNNING group
        makeRun({ created_at: bucket2, status: "SOME_UNKNOWN_STATUS" }), // folds into RUNNING
        // Deleted row — distinct run, _is_deleted = 1, must NOT be counted.
        makeRun({ created_at: bucket0, status: "COMPLETED_SUCCESSFULLY", _is_deleted: 1 }),
      ];

      const [insertError] = await insert(rows);
      expect(insertError).toBeNull();

      const throwingReplica = new Proxy(
        {},
        {
          get() {
            throw new Error("getActivity must not touch the run-ops Prisma client");
          },
        }
      ) as never;

      const presenter = new TaskDetailPresenter(throwingReplica, clickhouse);

      const activity = await presenter.getActivity({
        organizationId,
        projectId,
        environmentId,
        taskSlug,
        from,
        to,
      });

      // Stable legend, fixed group order.
      expect(activity.statuses).toEqual(["COMPLETED", "FAILED", "CANCELED", "RUNNING"]);

      // 72 five-minute buckets, every bucket carries all four group keys.
      expect(activity.data).toHaveLength(72);
      for (const point of activity.data) {
        expect(typeof point.bucket).toBe("number");
        expect(point).toHaveProperty("COMPLETED");
        expect(point).toHaveProperty("FAILED");
        expect(point).toHaveProperty("CANCELED");
        expect(point).toHaveProperty("RUNNING");
      }

      // Buckets are epoch MILLISECONDS aligned to the 5-minute interval.
      const byBucket = new Map(activity.data.map((p) => [p.bucket, p]));
      const p0 = byBucket.get(Math.floor(bucket0 / BUCKET_MS) * BUCKET_MS)!;
      const p2 = byBucket.get(Math.floor(bucket2 / BUCKET_MS) * BUCKET_MS)!;
      expect(p0).toBeDefined();
      expect(p2).toBeDefined();

      // 00:30 bucket: 1 COMPLETED, 1 FAILED, deleted row excluded.
      expect(p0.COMPLETED).toBe(1);
      expect(p0.FAILED).toBe(1);
      expect(p0.CANCELED).toBe(0);
      expect(p0.RUNNING).toBe(0);

      // 02:30 bucket: 1 CANCELED, RUNNING = EXECUTING (1) + unknown status (1) = 2.
      expect(p2.COMPLETED).toBe(0);
      expect(p2.FAILED).toBe(0);
      expect(p2.CANCELED).toBe(1);
      expect(p2.RUNNING).toBe(2);

      // Every other bucket is all-zero for every group.
      for (const point of activity.data) {
        if (point.bucket === p0.bucket || point.bucket === p2.bucket) continue;
        expect(point.COMPLETED).toBe(0);
        expect(point.FAILED).toBe(0);
        expect(point.CANCELED).toBe(0);
        expect(point.RUNNING).toBe(0);
      }
    }
  );
});
