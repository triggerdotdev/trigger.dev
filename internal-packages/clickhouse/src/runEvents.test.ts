import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickhouseClient } from "./client/client.js";
import { insertRunEvents } from "./runEvents.js";

describe("Run Events", () => {
  clickhouseTest("should be able to insert run events", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertRunEvents(client, {
      async_insert: 0, // turn off async insert for this test
    });

    const [insertError, insertResult] = await insert([
      {
        environment_id: "env_1234",
        environment_type: "DEVELOPMENT",
        organization_id: "org_1234",
        project_id: "project_1234",
        run_id: "run_1234",
        friendly_id: "friendly_1234",
        attempt: 1,
        engine: "V2",
        status: "PENDING",
        task_identifier: "my-task",
        queue: "my-queue",
        schedule_id: "schedule_1234",
        batch_id: "batch_1234",
        event_time: Date.now(),
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: Date.now(),
        tags: ["tag1", "tag2"],
        payload: {
          key: "value",
        },
        output: {
          key: "value",
        },
        error: {
          type: "BUILT_IN_ERROR",
          name: "Error",
          message: "error",
          stackTrace: "stack trace",
        },
        usage_duration_ms: 1000,
        cost_in_cents: 100,
        task_version: "1.0.0",
        sdk_version: "1.0.0",
        cli_version: "1.0.0",
        machine_preset: "small-1x",
        is_test: true,
        span_id: "span_1234",
        trace_id: "trace_1234",
        idempotency_key: "idempotency_key_1234",
        expiration_ttl: "1h",
        root_run_id: "root_run_1234",
        parent_run_id: "parent_run_1234",
        depth: 1,
      },
    ]);

    expect(insertError).toBeNull();
    expect(insertResult).toEqual(expect.objectContaining({ executed: true }));
    expect(insertResult?.summary?.written_rows).toEqual("1");

    const query = client.query({
      name: "query-run-events",
      query: "SELECT * FROM trigger_dev.raw_run_events_v1",
      schema: z.object({
        environment_id: z.string(),
        run_id: z.string(),
      }),
    });

    const [queryError, result] = await query({});

    expect(queryError).toBeNull();
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environment_id: "env_1234",
          run_id: "run_1234",
        }),
      ])
    );
  });
});
