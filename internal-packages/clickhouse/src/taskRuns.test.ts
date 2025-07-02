import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickhouseClient } from "./client/client.js";
import { getTaskRunsQueryBuilder, insertRawTaskRunPayloads, insertTaskRuns } from "./taskRuns.js";

describe("Task Runs V2", () => {
  clickhouseTest("should be able to insert task runs", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
      logLevel: "debug",
    });

    const insert = insertTaskRuns(client, {
      async_insert: 0, // turn off async insert for this test
    });

    const insertPayloads = insertRawTaskRunPayloads(client, {
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
        concurrency_key: "concurrency_key_1234",
        bulk_action_group_ids: ["bulk_action_group_id_1234", "bulk_action_group_id_1235"],
        _version: "1",
      },
    ]);

    expect(insertError).toBeNull();
    expect(insertResult).toEqual(expect.objectContaining({ executed: true }));
    expect(insertResult?.summary?.written_rows).toEqual("1");

    const query = client.query({
      name: "query-task-runs",
      query: "SELECT * FROM trigger_dev.task_runs_v2",
      schema: z.object({
        environment_id: z.string(),
        run_id: z.string(),
        concurrency_key: z.string(),
        bulk_action_group_ids: z.array(z.string()),
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
          concurrency_key: "concurrency_key_1234",
          bulk_action_group_ids: ["bulk_action_group_id_1234", "bulk_action_group_id_1235"],
        }),
      ])
    );

    const [insertPayloadsError, insertPayloadsResult] = await insertPayloads([
      {
        run_id: "run_1234",
        created_at: Date.now(),
        payload: {
          key: "value",
        },
      },
    ]);

    expect(insertPayloadsError).toBeNull();
    expect(insertPayloadsResult).toEqual(expect.objectContaining({ executed: true }));
    expect(insertPayloadsResult?.summary?.written_rows).toEqual("1");

    const queryPayloads = client.query({
      name: "query-raw-task-run-payloads",
      query: "SELECT * FROM trigger_dev.raw_task_runs_payload_v1",
      schema: z.object({
        run_id: z.string(),
        created_at: z.coerce.date(),
        payload: z.unknown(),
      }),
    });

    const [queryPayloadsError, resultPayloads] = await queryPayloads({ run_id: "run_1234" });

    expect(queryPayloadsError).toBeNull();
    expect(resultPayloads).toEqual(
      expect.arrayContaining([expect.objectContaining({ run_id: "run_1234" })])
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
        schedule_id: "",
        batch_id: "",
        root_run_id: "",
        parent_run_id: "",
        depth: 0,
        span_id: "538677637f937f54",
        trace_id: "20a28486b0b9f50c647b35e8863e36a5",
        idempotency_key: "",
        created_at: new Date("2025-04-30 16:34:04.312").getTime(),
        updated_at: new Date("2025-04-30 16:34:04.312").getTime(),
        started_at: null,
        executed_at: null,
        completed_at: null,
        delay_until: null,
        queued_at: new Date("2025-04-30 16:34:04.311").getTime(),
        expired_at: null,
        expiration_ttl: "",
        usage_duration_ms: 0,
        cost_in_cents: 0,
        base_cost_in_cents: 0,
        output: null,
        error: null,
        tags: [],
        task_version: "",
        sdk_version: "",
        cli_version: "",
        machine_preset: "",
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
        schedule_id: "",
        batch_id: "",
        root_run_id: "",
        parent_run_id: "",
        depth: 0,
        span_id: "538677637f937f54",
        trace_id: "20a28486b0b9f50c647b35e8863e36a5",
        idempotency_key: "",
        created_at: new Date("2025-04-30 16:34:04.312").getTime(),
        updated_at: new Date("2025-04-30 16:34:04.312").getTime(),
        started_at: null,
        executed_at: null,
        completed_at: null,
        delay_until: null,
        queued_at: new Date("2025-04-30 16:34:04.311").getTime(),
        expired_at: null,
        expiration_ttl: "",
        usage_duration_ms: 0,
        cost_in_cents: 0,
        base_cost_in_cents: 0,
        output: null,
        error: null,
        tags: [],
        task_version: "",
        sdk_version: "",
        cli_version: "",
        machine_preset: "",
        is_test: true,
        _version: "2",
      },
    ]);

    expect(insertError).toBeNull();
    expect(insertResult).toEqual(expect.objectContaining({ executed: true }));

    const query = client.query({
      name: "query-task-runs",
      query: "SELECT * FROM trigger_dev.task_runs_v2 FINAL",
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

  clickhouseTest(
    "should be able to query task runs using the query builder",
    async ({ clickhouseContainer }) => {
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
          schedule_id: "",
          batch_id: "",
          root_run_id: "",
          parent_run_id: "",
          depth: 0,
          span_id: "538677637f937f54",
          trace_id: "20a28486b0b9f50c647b35e8863e36a5",
          idempotency_key: "",
          created_at: new Date("2025-04-30 16:34:04.312").getTime(),
          updated_at: new Date("2025-04-30 16:34:04.312").getTime(),
          started_at: null,
          executed_at: null,
          completed_at: null,
          delay_until: null,
          queued_at: new Date("2025-04-30 16:34:04.311").getTime(),
          expired_at: null,
          expiration_ttl: "",
          usage_duration_ms: 0,
          cost_in_cents: 0,
          base_cost_in_cents: 0,
          output: null,
          error: null,
          tags: [],
          task_version: "",
          sdk_version: "",
          cli_version: "",
          machine_preset: "",
          is_test: true,
          _version: "1",
        },
      ]);

      const queryBuilder = getTaskRunsQueryBuilder(client)();
      queryBuilder.where("environment_id = {environmentId: String}", {
        environmentId: "cm9kddfcs01zqdy88ld9mmrli",
      });

      expect(queryBuilder.build()).toMatchSnapshot();

      const [queryError, result] = await queryBuilder.execute();

      expect(queryError).toBeNull();
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            run_id: "cma45oli70002qrdy47w0j4n7",
          }),
        ])
      );

      const queryBuilder2 = getTaskRunsQueryBuilder(client)();

      queryBuilder2
        .where("environment_id = {environmentId: String}", {
          environmentId: "cm9kddfcs01zqdy88ld9mmrli",
        })
        .whereIf(true, "status = {status: String}", {
          status: "COMPLETED_SUCCESSFULLY",
        });

      expect(queryBuilder2.build()).toMatchSnapshot();

      const [queryError2, result2] = await queryBuilder2.execute();

      expect(queryError2).toBeNull();
      expect(result2).toEqual([]);
    }
  );

  clickhouseTest(
    "should be able to insert payloads with a duplicate path",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insertPayloads = insertRawTaskRunPayloads(client, {
        async_insert: 0, // turn off async insert for this test
      });

      const [insertPayloadsError, insertPayloadsResult] = await insertPayloads([
        {
          run_id: "run_1234",
          created_at: Date.now(),
          payload: {
            data: {
              title: {
                id: "123",
              },
              "title.id": 123,
            },
          },
        },
      ]);

      expect(insertPayloadsError).toBeNull();
      expect(insertPayloadsResult).toEqual(expect.objectContaining({ executed: true }));
      expect(insertPayloadsResult?.summary?.written_rows).toEqual("1");

      const queryPayloads = client.query({
        name: "query-raw-task-run-payloads",
        query: "SELECT * FROM trigger_dev.raw_task_runs_payload_v1",
        schema: z.object({
          run_id: z.string(),
          created_at: z.coerce.date(),
          payload: z.unknown(),
        }),
      });

      const [queryPayloadsError, resultPayloads] = await queryPayloads({ run_id: "run_1234" });

      expect(queryPayloadsError).toBeNull();
      expect(resultPayloads).toEqual(
        expect.arrayContaining([expect.objectContaining({ run_id: "run_1234" })])
      );
    }
  );
});
