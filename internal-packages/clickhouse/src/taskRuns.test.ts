import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickhouseClient } from "./client/client.js";
import {
  getTaskRunsQueryBuilder,
  insertRawTaskRunPayloadsCompactArrays,
  insertTaskRunsCompactArrays,
  type TaskRunInsertArray,
  type PayloadInsertArray,
} from "./taskRuns.js";

describe("Task Runs V2", () => {
  clickhouseTest("should be able to insert task runs", async ({ clickhouseContainer }) => {
    const client = new ClickhouseClient({
      name: "test",
      url: clickhouseContainer.getConnectionUrl(),
      logLevel: "debug",
    });

    const insert = insertTaskRunsCompactArrays(client, {
      async_insert: 0, // turn off async insert for this test
    });

    const insertPayloads = insertRawTaskRunPayloadsCompactArrays(client, {
      async_insert: 0, // turn off async insert for this test
    });

    const now = Date.now();
    const taskRunData: TaskRunInsertArray = [
      "env_1234", // environment_id
      "org_1234", // organization_id
      "project_1234", // project_id
      "run_1234", // run_id
      now, // updated_at
      now, // created_at
      "PENDING", // status
      "DEVELOPMENT", // environment_type
      "friendly_1234", // friendly_id
      1, // attempt
      "V2", // engine
      "my-task", // task_identifier
      "my-queue", // queue
      "schedule_1234", // schedule_id
      "batch_1234", // batch_id
      null, // completed_at
      null, // started_at
      null, // executed_at
      null, // delay_until
      null, // queued_at
      null, // expired_at
      1000, // usage_duration_ms
      100, // cost_in_cents
      0, // base_cost_in_cents
      { data: { key: "value" } }, // output
      { data: { type: "BUILT_IN_ERROR", name: "Error", message: "error", stackTrace: "stack trace" } }, // error
      ["tag1", "tag2"], // tags
      "1.0.0", // task_version
      "1.0.0", // sdk_version
      "1.0.0", // cli_version
      "small-1x", // machine_preset
      "root_run_1234", // root_run_id
      "parent_run_1234", // parent_run_id
      1, // depth
      "span_1234", // span_id
      "trace_1234", // trace_id
      "idempotency_key_1234", // idempotency_key
      "my-user-key", // idempotency_key_user
      "run", // idempotency_key_scope
      "1h", // expiration_ttl
      true, // is_test
      "1", // _version
      0, // _is_deleted
      "concurrency_key_1234", // concurrency_key
      ["bulk_action_group_id_1234", "bulk_action_group_id_1235"], // bulk_action_group_ids
      "", // worker_queue
      null, // max_duration_in_seconds
    ];

    const [insertError, insertResult] = await insert([taskRunData]);

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

    const payloadData: PayloadInsertArray = [
      "run_1234", // run_id
      Date.now(), // created_at
      { data: { key: "value" } }, // payload
    ];

    const [insertPayloadsError, insertPayloadsResult] = await insertPayloads([payloadData]);

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

    const insert = insertTaskRunsCompactArrays(client, {
      async_insert: 0, // turn off async insert for this test
    });

    const createdAt = new Date("2025-04-30 16:34:04.312").getTime();
    const queuedAt = new Date("2025-04-30 16:34:04.311").getTime();

    const run1: TaskRunInsertArray = [
      "cm9kddfcs01zqdy88ld9mmrli", // environment_id
      "cm8zs78wb0002dy616dg75tv3", // organization_id
      "cm9kddfbz01zpdy88t9dstecu", // project_id
      "cma45oli70002qrdy47w0j4n7", // run_id
      createdAt, // updated_at
      createdAt, // created_at
      "PENDING", // status
      "PRODUCTION", // environment_type
      "run_cma45oli70002qrdy47w0j4n7", // friendly_id
      1, // attempt
      "V2", // engine
      "retry-task", // task_identifier
      "task/retry-task", // queue
      "", // schedule_id
      "", // batch_id
      null, // completed_at
      null, // started_at
      null, // executed_at
      null, // delay_until
      queuedAt, // queued_at
      null, // expired_at
      0, // usage_duration_ms
      0, // cost_in_cents
      0, // base_cost_in_cents
      { data: null }, // output
      { data: null }, // error
      [], // tags
      "", // task_version
      "", // sdk_version
      "", // cli_version
      "", // machine_preset
      "", // root_run_id
      "", // parent_run_id
      0, // depth
      "538677637f937f54", // span_id
      "20a28486b0b9f50c647b35e8863e36a5", // trace_id
      "", // idempotency_key
      "", // idempotency_key_user
      "", // idempotency_key_scope
      "", // expiration_ttl
      true, // is_test
      "1", // _version
      0, // _is_deleted
      "", // concurrency_key
      [], // bulk_action_group_ids
      "", // worker_queue
      null, // max_duration_in_seconds
    ];

    const run2: TaskRunInsertArray = [
      "cm9kddfcs01zqdy88ld9mmrli", // environment_id
      "cm8zs78wb0002dy616dg75tv3", // organization_id
      "cm9kddfbz01zpdy88t9dstecu", // project_id
      "cma45oli70002qrdy47w0j4n7", // run_id
      createdAt, // updated_at
      createdAt, // created_at
      "COMPLETED_SUCCESSFULLY", // status
      "PRODUCTION", // environment_type
      "run_cma45oli70002qrdy47w0j4n7", // friendly_id
      1, // attempt
      "V2", // engine
      "retry-task", // task_identifier
      "task/retry-task", // queue
      "", // schedule_id
      "", // batch_id
      null, // completed_at
      null, // started_at
      null, // executed_at
      null, // delay_until
      queuedAt, // queued_at
      null, // expired_at
      0, // usage_duration_ms
      0, // cost_in_cents
      0, // base_cost_in_cents
      { data: null }, // output
      { data: null }, // error
      [], // tags
      "", // task_version
      "", // sdk_version
      "", // cli_version
      "", // machine_preset
      "", // root_run_id
      "", // parent_run_id
      0, // depth
      "538677637f937f54", // span_id
      "20a28486b0b9f50c647b35e8863e36a5", // trace_id
      "", // idempotency_key
      "", // idempotency_key_user
      "", // idempotency_key_scope
      "", // expiration_ttl
      true, // is_test
      "2", // _version
      0, // _is_deleted
      "", // concurrency_key
      [], // bulk_action_group_ids
      "", // worker_queue
      null, // max_duration_in_seconds
    ];

    const [insertError, insertResult] = await insert([run1, run2]);

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

      const insert = insertTaskRunsCompactArrays(client, {
        async_insert: 0, // turn off async insert for this test
      });

      const createdAt = new Date("2025-04-30 16:34:04.312").getTime();
      const queuedAt = new Date("2025-04-30 16:34:04.311").getTime();

      const taskRun: TaskRunInsertArray = [
        "cm9kddfcs01zqdy88ld9mmrli", // environment_id
        "cm8zs78wb0002dy616dg75tv3", // organization_id
        "cm9kddfbz01zpdy88t9dstecu", // project_id
        "cma45oli70002qrdy47w0j4n7", // run_id
        createdAt, // updated_at
        createdAt, // created_at
        "PENDING", // status
        "PRODUCTION", // environment_type
        "run_cma45oli70002qrdy47w0j4n7", // friendly_id
        1, // attempt
        "V2", // engine
        "retry-task", // task_identifier
        "task/retry-task", // queue
        "", // schedule_id
        "", // batch_id
        null, // completed_at
        null, // started_at
        null, // executed_at
        null, // delay_until
        queuedAt, // queued_at
        null, // expired_at
        0, // usage_duration_ms
        0, // cost_in_cents
        0, // base_cost_in_cents
        { data: null }, // output
        { data: null }, // error
        [], // tags
        "", // task_version
        "", // sdk_version
        "", // cli_version
        "", // machine_preset
        "", // root_run_id
        "", // parent_run_id
        0, // depth
        "538677637f937f54", // span_id
        "20a28486b0b9f50c647b35e8863e36a5", // trace_id
        "", // idempotency_key
        "", // idempotency_key_user
        "", // idempotency_key_scope
        "", // expiration_ttl
        true, // is_test
        "1", // _version
        0, // _is_deleted
        "", // concurrency_key
        [], // bulk_action_group_ids
        "", // worker_queue
        null, // max_duration_in_seconds
      ];

      const [insertError, insertResult] = await insert([taskRun]);

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

      const insertPayloads = insertRawTaskRunPayloadsCompactArrays(client, {
        async_insert: 0, // turn off async insert for this test
      });

      const payloadData: PayloadInsertArray = [
        "run_1234", // run_id
        Date.now(), // created_at
        {
          data: {
            data: {
              title: {
                id: "123",
              },
              "title.id": 123,
            },
          },
        }, // payload
      ];

      const [insertPayloadsError, insertPayloadsResult] = await insertPayloads([payloadData]);

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
