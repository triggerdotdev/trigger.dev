import { clickhouseTest } from "@internal/testcontainers";
import { z } from "zod";
import { ClickhouseClient } from "./client/client.js";
import {
  TASK_RUN_INDEX,
  getChildRunStatusCounts,
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
      {
        data: {
          type: "BUILT_IN_ERROR",
          name: "Error",
          message: "error",
          stackTrace: "stack trace",
        },
      }, // error
      "1234567890", // error_fingerprint
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
      "", // region
      "", // plan_type
      null, // max_duration_in_seconds
      "", // trigger_source
      "", // root_trigger_source
      "", // task_kind
      null, // is_warm_start
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

  clickhouseTest(
    "should insert and read back JSON arrays with mixed element types",
    async ({ clickhouseContainer }) => {
      // Regression test for input_format_json_infer_array_of_dynamic_from_array_of_different_types.
      // Arrays with mixed element types (e.g. [1, "hello", {...}, [...]]) must be inferred as
      // Array(Dynamic) rather than deeply nested Tuple types, which otherwise blow up the binary
      // type-complexity limit during background merges (ClickHouse Code 117).
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRunsCompactArrays(client, {
        async_insert: 0, // turn off async insert for this test
      });

      const mixedArray = [1, "hello", { nested: "object" }, [1, 2, 3]];

      const now = Date.now();
      const taskRunData: TaskRunInsertArray = [
        "env_mixed", // environment_id
        "org_mixed", // organization_id
        "project_mixed", // project_id
        "run_mixed", // run_id
        now, // updated_at
        now, // created_at
        "COMPLETED_SUCCESSFULLY", // status
        "DEVELOPMENT", // environment_type
        "friendly_mixed", // friendly_id
        1, // attempt
        "V2", // engine
        "my-task", // task_identifier
        "my-queue", // queue
        "", // schedule_id
        "", // batch_id
        null, // completed_at
        null, // started_at
        null, // executed_at
        null, // delay_until
        null, // queued_at
        null, // expired_at
        0, // usage_duration_ms
        0, // cost_in_cents
        0, // base_cost_in_cents
        { data: { items: mixedArray } }, // output
        { data: null }, // error
        "", // error_fingerprint
        [], // tags
        "", // task_version
        "", // sdk_version
        "", // cli_version
        "", // machine_preset
        "", // root_run_id
        "", // parent_run_id
        0, // depth
        "span_mixed", // span_id
        "trace_mixed", // trace_id
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
        "", // region
        "", // plan_type
        null, // max_duration_in_seconds
        "", // trigger_source
        "", // root_trigger_source
        "", // task_kind
        null, // is_warm_start
      ];

      const [insertError, insertResult] = await insert([taskRunData]);

      expect(insertError).toBeNull();
      expect(insertResult).toEqual(expect.objectContaining({ executed: true }));
      expect(insertResult?.summary?.written_rows).toEqual("1");

      // output_text is a materialized String column that extracts the `data` field, so it
      // round-trips the mixed-type array back out as JSON regardless of the internal storage type.
      const query = client.query({
        name: "query-task-runs-mixed",
        query: "SELECT run_id, output_text FROM trigger_dev.task_runs_v2 WHERE run_id = {run_id: String}",
        schema: z.object({
          run_id: z.string(),
          output_text: z.string(),
        }),
        params: z.object({
          run_id: z.string(),
        }),
      });

      const [queryError, result] = await query({ run_id: "run_mixed" });

      expect(queryError).toBeNull();
      expect(result).toHaveLength(1);
      expect(JSON.parse(result![0].output_text)).toEqual({ items: mixedArray });
    }
  );

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
      "", // error_fingerprint
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
      "", // region
      "", // plan_type
      null, // max_duration_in_seconds
      "", // trigger_source
      "", // root_trigger_source
      "", // task_kind
      null, // is_warm_start
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
      "", // error_fingerprint
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
      "", // region
      "", // plan_type
      null, // max_duration_in_seconds
      "", // trigger_source
      "", // root_trigger_source
      "", // task_kind
      null, // is_warm_start
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
        "", // error_fingerprint
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
        "", // region
        "", // plan_type
        null, // max_duration_in_seconds
        "", // trigger_source
        "", // root_trigger_source
        "", // task_kind
        null, // is_warm_start
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
    "should aggregate child status counts with FINAL and ignore deleted rows",
    async ({ clickhouseContainer }) => {
      const client = new ClickhouseClient({
        name: "test",
        url: clickhouseContainer.getConnectionUrl(),
      });

      const insert = insertTaskRunsCompactArrays(client, {
        async_insert: 0, // turn off async insert for this test
      });

      const baseCreatedAt = new Date("2025-05-01T12:00:00.000Z").getTime();
      const oldCreatedAt = new Date("2025-04-15T12:00:00.000Z").getTime();
      const since = baseCreatedAt - 60_000;

      const rootRun: TaskRunInsertArray = [
        "env_agg", // environment_id
        "org_agg", // organization_id
        "project_agg", // project_id
        "root_run_1", // run_id
        baseCreatedAt, // updated_at
        baseCreatedAt, // created_at
        "EXECUTING", // status
        "DEVELOPMENT", // environment_type
        "run_root_1", // friendly_id
        1, // attempt
        "V2", // engine
        "root-task", // task_identifier
        "task/root-task", // queue
        "", // schedule_id
        "", // batch_id
        null, // completed_at
        baseCreatedAt, // started_at
        null, // executed_at
        null, // delay_until
        baseCreatedAt, // queued_at
        null, // expired_at
        0, // usage_duration_ms
        0, // cost_in_cents
        0, // base_cost_in_cents
        { data: null }, // output
        { data: null }, // error
        "", // error_fingerprint
        [], // tags
        "", // task_version
        "", // sdk_version
        "", // cli_version
        "", // machine_preset
        "", // root_run_id
        "", // parent_run_id
        0, // depth
        "span_root", // span_id
        "trace_root", // trace_id
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
        "", // region
        "", // plan_type
        null, // max_duration_in_seconds
        "", // trigger_source
        "", // root_trigger_source
        "", // task_kind
        null, // is_warm_start
      ];

      const childA_v1: TaskRunInsertArray = [
        "env_agg",
        "org_agg",
        "project_agg",
        "child_a",
        baseCreatedAt + 1_000,
        baseCreatedAt + 1_000,
        "PENDING",
        "DEVELOPMENT",
        "run_child_a",
        1,
        "V2",
        "child-task",
        "task/child-task",
        "",
        "",
        null,
        null,
        null,
        null,
        baseCreatedAt + 1_000,
        null,
        0,
        0,
        0,
        { data: null },
        { data: null },
        "",
        [],
        "",
        "",
        "",
        "",
        "root_run_1",
        "root_run_1",
        1,
        "span_child_a",
        "trace_root",
        "",
        "",
        "",
        "",
        true,
        "1",
        0,
        "",
        [],
        "", // worker_queue
        "", // region
        "", // plan_type
        null,
        "",
        "",
        "",
        null,
      ];

      const childA_v2: TaskRunInsertArray = [...childA_v1];
      childA_v2[TASK_RUN_INDEX.status] = "COMPLETED_SUCCESSFULLY";
      childA_v2[TASK_RUN_INDEX._version] = "2";

      const childB: TaskRunInsertArray = [
        "env_agg",
        "org_agg",
        "project_agg",
        "child_b",
        baseCreatedAt + 2_000,
        baseCreatedAt + 2_000,
        "EXECUTING",
        "DEVELOPMENT",
        "run_child_b",
        1,
        "V2",
        "child-task",
        "task/child-task",
        "",
        "",
        null,
        baseCreatedAt + 2_000,
        null,
        null,
        baseCreatedAt + 2_000,
        null,
        0,
        0,
        0,
        { data: null },
        { data: null },
        "",
        [],
        "",
        "",
        "",
        "",
        "root_run_1",
        "root_run_1",
        1,
        "span_child_b",
        "trace_root",
        "",
        "",
        "",
        "",
        true,
        "1",
        0,
        "",
        [],
        "", // worker_queue
        "", // region
        "", // plan_type
        null,
        "",
        "",
        "",
        null,
      ];

      const childDeleted_v1: TaskRunInsertArray = [
        "env_agg",
        "org_agg",
        "project_agg",
        "child_deleted",
        baseCreatedAt + 3_000,
        baseCreatedAt + 3_000,
        "PENDING",
        "DEVELOPMENT",
        "run_child_deleted",
        1,
        "V2",
        "child-task",
        "task/child-task",
        "",
        "",
        null,
        null,
        null,
        null,
        baseCreatedAt + 3_000,
        null,
        0,
        0,
        0,
        { data: null },
        { data: null },
        "",
        [],
        "",
        "",
        "",
        "",
        "root_run_1",
        "root_run_1",
        1,
        "span_child_deleted",
        "trace_root",
        "",
        "",
        "",
        "",
        true,
        "1",
        0,
        "",
        [],
        "", // worker_queue
        "", // region
        "", // plan_type
        null,
        "",
        "",
        "",
        null,
      ];

      const childDeleted_v2: TaskRunInsertArray = [...childDeleted_v1];
      childDeleted_v2[TASK_RUN_INDEX._version] = "2";
      childDeleted_v2[TASK_RUN_INDEX._is_deleted] = 1;

      const childWrongRoot: TaskRunInsertArray = [...childB];
      childWrongRoot[TASK_RUN_INDEX.run_id] = "child_wrong_root";
      childWrongRoot[TASK_RUN_INDEX.friendly_id] = "run_child_wrong_root";
      childWrongRoot[TASK_RUN_INDEX.root_run_id] = "other_root";
      childWrongRoot[TASK_RUN_INDEX.parent_run_id] = "other_root";
      childWrongRoot[TASK_RUN_INDEX.span_id] = "span_child_wrong_root";

      const childOld: TaskRunInsertArray = [...childB];
      childOld[TASK_RUN_INDEX.run_id] = "child_old";
      childOld[TASK_RUN_INDEX.created_at] = oldCreatedAt;
      childOld[TASK_RUN_INDEX.updated_at] = oldCreatedAt;
      childOld[TASK_RUN_INDEX.started_at] = oldCreatedAt;
      childOld[TASK_RUN_INDEX.queued_at] = oldCreatedAt;
      childOld[TASK_RUN_INDEX.friendly_id] = "run_child_old";
      childOld[TASK_RUN_INDEX.span_id] = "span_child_old";

      const [insertError] = await insert([
        rootRun,
        childA_v1,
        childA_v2,
        childB,
        childDeleted_v1,
        childDeleted_v2,
        childWrongRoot,
        childOld,
      ]);

      expect(insertError).toBeNull();

      const [queryError, result] = await getChildRunStatusCounts(client)({
        organizationId: "org_agg",
        projectId: "project_agg",
        environmentId: "env_agg",
        rootRunIds: ["root_run_1"],
        since,
      });

      expect(queryError).toBeNull();
      expect(result).toEqual([
        {
          root_run_id: "root_run_1",
          status: "COMPLETED_SUCCESSFULLY",
          count: 1,
        },
        {
          root_run_id: "root_run_1",
          status: "EXECUTING",
          count: 1,
        },
      ]);
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
