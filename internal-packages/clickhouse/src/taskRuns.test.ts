import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickhouseClient } from "./client/client.js";
import { insertTaskRuns } from "./taskRuns.js";

describe("Task Runs V1", () => {
  clickhouseTest("should be able to insert task runs", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, {
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
        created_at: Date.now(),
        updated_at: Date.now(),
        completed_at: undefined,
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
        _version: "1",
      },
    ]);

    expect(insertError).toBeNull();
    expect(insertResult).toEqual(expect.objectContaining({ executed: true }));
    expect(insertResult?.summary?.written_rows).toEqual("1");

    const query = client.query({
      name: "query-task-runs",
      query: "SELECT * FROM trigger_dev.task_runs_v1",
      schema: z.object({
        environment_id: z.string(),
        run_id: z.string(),
      }),
      params: z.object({
        run_id: z.string(),
      }),
    });

    const [queryError, result] = await query({ run_id: "run_1234" });

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

  clickhouseTest("should deduplicate on the _version column", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
    });

    const insert = insertTaskRuns(client, {
      async_insert: 0, // turn off async insert for this test
    });

    const [insertError, insertResult] = await insert([
      {
        environment_id: "cm9kddfcs01zqdy88ld9mmrli",
        organization_id: "cm8zs78wb0002dy616dg75tv3",
        project_id: "cm9kddfbz01zpdy88t9dstecu",
        run_id: "cma45oli70002qrdy47w0j4n7",
        environment_type: "PRODUCTION",
        friendly_id: "run_cma45oli70002qrdy47w0j4n7",
        attempt: 1,
        engine: "V2",
        status: "PENDING",
        task_identifier: "retry-task",
        queue: "task/retry-task",
        schedule_id: null,
        batch_id: null,
        root_run_id: null,
        parent_run_id: null,
        depth: 0,
        span_id: "538677637f937f54",
        trace_id: "20a28486b0b9f50c647b35e8863e36a5",
        idempotency_key: null,
        created_at: new Date("2025-04-30 16:34:04.312").getTime(),
        updated_at: new Date("2025-04-30 16:34:04.312").getTime(),
        started_at: null,
        executed_at: null,
        completed_at: null,
        delay_until: null,
        queued_at: new Date("2025-04-30 16:34:04.311").getTime(),
        expired_at: null,
        expiration_ttl: null,
        usage_duration_ms: 0,
        cost_in_cents: 0,
        base_cost_in_cents: 0,
        payload: { failCount: "3" },
        output: null,
        error: null,
        tags: [],
        task_version: null,
        sdk_version: null,
        cli_version: null,
        machine_preset: null,
        is_test: true,
        _version: "1",
      },
      {
        environment_id: "cm9kddfcs01zqdy88ld9mmrli",
        organization_id: "cm8zs78wb0002dy616dg75tv3",
        project_id: "cm9kddfbz01zpdy88t9dstecu",
        run_id: "cma45oli70002qrdy47w0j4n7",
        environment_type: "PRODUCTION",
        friendly_id: "run_cma45oli70002qrdy47w0j4n7",
        attempt: 1,
        engine: "V2",
        status: "COMPLETED_SUCCESSFULLY",
        task_identifier: "retry-task",
        queue: "task/retry-task",
        schedule_id: null,
        batch_id: null,
        root_run_id: null,
        parent_run_id: null,
        depth: 0,
        span_id: "538677637f937f54",
        trace_id: "20a28486b0b9f50c647b35e8863e36a5",
        idempotency_key: null,
        created_at: new Date("2025-04-30 16:34:04.312").getTime(),
        updated_at: new Date("2025-04-30 16:34:04.312").getTime(),
        started_at: null,
        executed_at: null,
        completed_at: null,
        delay_until: null,
        queued_at: new Date("2025-04-30 16:34:04.311").getTime(),
        expired_at: null,
        expiration_ttl: null,
        usage_duration_ms: 0,
        cost_in_cents: 0,
        base_cost_in_cents: 0,
        payload: { failCount: "3" },
        output: null,
        error: null,
        tags: [],
        task_version: null,
        sdk_version: null,
        cli_version: null,
        machine_preset: null,
        is_test: true,
        _version: "2",
      },
    ]);

    expect(insertError).toBeNull();
    expect(insertResult).toEqual(expect.objectContaining({ executed: true }));

    const query = client.query({
      name: "query-run-events",
      query: "SELECT * FROM trigger_dev.task_runs_v1 FINAL",
      schema: z.object({
        environment_id: z.string(),
        run_id: z.string(),
        status: z.string(),
      }),
      params: z.object({
        run_id: z.string(),
      }),
    });

    const [queryError, result] = await query({ run_id: "cma45oli70002qrdy47w0j4n7" });

    expect(queryError).toBeNull();
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environment_id: "cm9kddfcs01zqdy88ld9mmrli",
          run_id: "cma45oli70002qrdy47w0j4n7",
          status: "COMPLETED_SUCCESSFULLY",
        }),
      ])
    );
  });
});
