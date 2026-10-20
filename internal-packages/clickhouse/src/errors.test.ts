import { clickhouseTest } from "@internal/testcontainers";
import { ClickhouseClient } from "./client/client.js";
import { insertTaskRunsCompactArrays, type TaskRunInsertArray } from "./taskRuns.js";

function failedRun(runId: string, createdAt: number, completedAt: number): TaskRunInsertArray {
  return [
    "env_1234", // environment_id
    "org_1234", // organization_id
    "project_1234", // project_id
    runId, // run_id
    completedAt, // updated_at
    createdAt, // created_at
    createdAt, // queue_timestamp
    "COMPLETED_WITH_ERRORS", // status
    "PRODUCTION", // environment_type
    `friendly_${runId}`, // friendly_id
    1, // attempt
    "V2", // engine
    "my-task", // task_identifier
    "my-queue", // queue
    "", // schedule_id
    "", // batch_id
    completedAt, // completed_at
    createdAt, // started_at
    createdAt, // executed_at
    null, // delay_until
    createdAt, // queued_at
    null, // expired_at
    1000, // usage_duration_ms
    0, // cost_in_cents
    0, // base_cost_in_cents
    { data: {} }, // output
    { data: { type: "BUILT_IN_ERROR", name: "Error", message: "boom", stackTrace: "stack" } }, // error
    "fingerprint_1234", // error_fingerprint
    [], // tags
    "1.0.0", // task_version
    "1.0.0", // sdk_version
    "1.0.0", // cli_version
    "small-1x", // machine_preset
    runId, // root_run_id
    "", // parent_run_id
    0, // depth
    "span_1234", // span_id
    "trace_1234", // trace_id
    "", // idempotency_key
    "", // idempotency_key_user
    "", // idempotency_key_scope
    "", // expiration_ttl
    false, // is_test
    "1", // _version
    0, // _is_deleted
    "", // concurrency_key
    [], // bulk_action_group_ids
    "", // worker_queue
    "", // region
    "", // plan_type
    null, // max_duration_in_seconds
    "", // trigger_source
    "", // root_trigger_source
    "", // task_kind
    null, // is_warm_start
    "", // external_deployment_id
    "", // worker_cell
    "", // worker_lane
  ];
}

describe("Error materialized views", () => {
  clickhouseTest(
    "key errors by failure time, not trigger time",
    async ({ clickhouseContainer, clickhouseClient }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });
      const insert = insertTaskRunsCompactArrays(client, { async_insert: 0 });

      const completedAt = Date.now();
      const createdAt = completedAt - 5 * 60 * 60 * 1000;

      const [insertError] = await insert([failedRun("run_long", createdAt, completedAt)]);
      expect(insertError).toBeNull();

      const occurrences = await clickhouseClient
        .query({
          query:
            "SELECT toUnixTimestamp(minute) AS minute FROM trigger_dev.error_occurrences_v1 WHERE error_fingerprint = 'fingerprint_1234'",
          format: "JSONEachRow",
        })
        .then((r) => r.json<{ minute: number }>());

      const expectedMinute = Math.floor(completedAt / 60_000) * 60;
      expect(occurrences).toEqual([{ minute: expectedMinute }]);

      const errors = await clickhouseClient
        .query({
          query:
            "SELECT toUnixTimestamp64Milli(min(first_seen)) AS first_seen, toUnixTimestamp64Milli(max(last_seen)) AS last_seen, toUnixTimestamp(max(last_seen_date)) AS last_seen_date FROM trigger_dev.errors_v1 WHERE error_fingerprint = 'fingerprint_1234'",
          format: "JSONEachRow",
        })
        .then((r) => r.json<{ first_seen: string; last_seen: string; last_seen_date: number }>());

      expect(Number(errors[0]?.first_seen)).toBe(completedAt);
      expect(Number(errors[0]?.last_seen)).toBe(completedAt);
      expect(errors[0]?.last_seen_date).toBe(Math.floor(completedAt / 1000));
    }
  );
});
