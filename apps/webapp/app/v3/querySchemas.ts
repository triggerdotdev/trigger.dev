import { column, type TableSchema } from "@internal/tsql";
import { autoFormatSQL } from "~/components/code/TSQLEditor";
import { runFriendlyStatus, runStatusTitleFromStatus } from "~/components/runs/v3/TaskRunStatus";
import { logger } from "~/services/logger.server";

/**
 * Environment type values
 */
const ENVIRONMENT_TYPES = ["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"] as const;

/**
 * Machine preset values
 */
const MACHINE_PRESETS = [
  "micro",
  "small-1x",
  "small-2x",
  "medium-1x",
  "medium-2x",
  "large-1x",
  "large-2x",
] as const;

/**
 * Schema definition for the runs table (trigger_dev.task_runs_v2)
 */
export const runsSchema: TableSchema = {
  name: "runs",
  clickhouseName: "trigger_dev.task_runs_v2",
  description: "Task runs - stores all task execution records",
  tenantColumns: {
    organizationId: "organization_id",
    projectId: "project_id",
    environmentId: "environment_id",
  },
  requiredFilters: [{ column: "engine", value: "V2" }],
  columns: {
    run_id: {
      name: "run_id",
      clickhouseName: "friendly_id",
      ...column("String", {
        description:
          "A unique ID for a run. They always start with `run_`, e.g., run_cm1a2b3c4d5e6f7g8h9i",
        customRenderType: "runId",
        example: "run_cm1a2b3c4d5e6f7g8h9i",
        coreColumn: true,
      }),
    },
    environment: {
      name: "environment",
      clickhouseName: "environment_id",
      ...column("String", { description: "The environment slug", example: "prod" }),
      fieldMapping: "environment",
      customRenderType: "environment",
    },
    project: {
      name: "project",
      clickhouseName: "project_id",
      ...column("String", {
        description: "The project reference, they always start with `proj_`.",
        example: "proj_howcnaxbfxdmwmxazktx",
      }),
      fieldMapping: "project",
      customRenderType: "project",
    },
    environment_type: {
      name: "environment_type",
      ...column("LowCardinality(String)", {
        description: "Environment type",
        allowedValues: [...ENVIRONMENT_TYPES],
        customRenderType: "environmentType",
        example: "PRODUCTION",
      }),
    },
    attempt_count: {
      name: "attempt_count",
      clickhouseName: "attempt",
      ...column("UInt8", {
        description: "Number of attempts (starts at 1)",
        example: "1",
        customRenderType: "number",
      }),
    },
    status: {
      name: "status",
      ...column("LowCardinality(String)", {
        description: "Run status",
        allowedValues: [...runFriendlyStatus],
        valueMap: runStatusTitleFromStatus,
        customRenderType: "runStatus",
        example: "Completed",
        coreColumn: true,
      }),
    },
    is_finished: {
      name: "is_finished",
      ...column("UInt8", {
        description:
          "Whether the run is finished. This includes failed and successful runs. (0 or 1)",
        example: "0",
      }),
      expression:
        "if(status IN ('COMPLETED_SUCCESSFULLY', 'COMPLETED_WITH_ERRORS', 'CANCELED', 'TIMED_OUT', 'CRASHED', 'SYSTEM_FAILURE', 'EXPIRED', 'PAUSED'), true, false)",
    },

    // Task & queue
    task_identifier: {
      name: "task_identifier",
      ...column("String", {
        description: "Task identifier/slug",
        example: "my-background-task",
        coreColumn: true,
      }),
    },
    queue: {
      name: "queue",
      ...column("String", {
        description: "Queue name",
        example: "task/my-background-task",
        customRenderType: "queue",
      }),
    },

    batch_id: {
      name: "batch_id",
      ...column("String", {
        description: "Batch ID (if part of a batch)",
        example: "batch_5678efgh",
        expression: "if(batch_id = '', NULL, 'batch_' || batch_id)",
      }),
      whereTransform: (value: string) => value.replace(/^batch_/, ""),
    },

    // Related runs
    root_run_id: {
      name: "root_run_id",
      ...column("String", {
        description: "Root run ID (for child runs)",
        example: "run_cm1a2b3c4d5e6f7g8h9i",
        customRenderType: "runId",
        expression: "if(root_run_id = '', NULL, 'run_' || root_run_id)",
      }),
      whereTransform: (value: string) => value.replace(/^run_/, ""),
    },
    parent_run_id: {
      name: "parent_run_id",
      ...column("String", {
        description: "Parent run ID (for child runs)",
        example: "run_cm1a2b3c4d5e6f7g8h9i",
        customRenderType: "runId",
        expression: "if(parent_run_id = '', NULL, 'run_' || parent_run_id)",
      }),
      whereTransform: (value: string) => value.replace(/^run_/, ""),
    },
    depth: {
      name: "depth",
      ...column("UInt8", { description: "Nesting depth (0 for root runs)", example: "0" }),
    },
    is_root_run: {
      name: "is_root_run",
      ...column("UInt8", { description: "Whether this is a root run (0 or 1)", example: "0" }),
      expression: "if(depth = 0, true, false)",
    },
    is_child_run: {
      name: "is_child_run",
      ...column("UInt8", { description: "Whether this is a child run (0 or 1)", example: "0" }),
      expression: "if(depth > 0, true, false)",
    },

    idempotency_key: {
      name: "idempotency_key",
      clickhouseName: "idempotency_key_user",
      ...column("String", { description: "Idempotency key (available from 4.3.3)", example: "user-123-action-456" }),
    },
    idempotency_key_scope: {
      name: "idempotency_key_scope",
      ...column("String", { description: "The idempotency key scope determines whether a task should be considered unique within a parent run, a specific attempt, or globally. An empty value means there's no idempotency key set (available from 4.3.3).", example: "run", allowedValues: ["global", "run", "attempt"], }),
    },
    region: {
      name: "region",
      clickhouseName: "worker_queue",
      ...column("String", {
        description: "Region",
        example: "us-east-1",
      }),
      expression: "if(startsWith(worker_queue, 'cm'), NULL, worker_queue)",
    },

    // Timing
    triggered_at: {
      name: "triggered_at",
      clickhouseName: "created_at",
      ...column("DateTime64", {
        description: "When the run was triggered.",
        example: "2024-01-15 09:30:00.000",
        coreColumn: true,
      }),
    },
    queued_at: {
      name: "queued_at",
      ...column("Nullable(DateTime64)", {
        description:
          "When the run was added to the queue. This is normally the same time as the triggered_at time, unless a delay is passed in or it's a scheduled run.",
        example: "2024-01-15 09:30:01.000",
      }),
    },
    dequeued_at: {
      name: "dequeued_at",
      clickhouseName: "started_at",
      ...column("Nullable(DateTime64)", {
        description:
          "When the run was dequeued for execution. This happens when there is available concurrency to execute your run.",
        example: "2024-01-15 09:30:01.000",
      }),
    },
    executed_at: {
      name: "executed_at",
      ...column("Nullable(DateTime64)", {
        description: "When execution of the run began.",
        example: "2024-01-15 09:30:01.500",
      }),
    },
    completed_at: {
      name: "completed_at",
      ...column("Nullable(DateTime64)", {
        description: "When the run completed",
        example: "2024-01-15 09:30:05.000",
      }),
    },
    delay_until: {
      name: "delay_until",
      ...column("Nullable(DateTime64)", {
        description: "Delayed execution until this time",
        example: "2024-01-15 10:00:00.000",
      }),
    },
    has_delay: {
      name: "has_delay",
      ...column("UInt8", { description: "Whether the run had a delay passed in", example: "1" }),
      expression: "if(isNotNull(delay_until), true, false)",
    },
    expired_at: {
      name: "expired_at",
      ...column("Nullable(DateTime64)", {
        description:
          'If there was a TTL on the run, this is when the run "expired". By default dev runs have a TTL of 10 minutes.',
        example: "2024-01-15 09:35:00.000",
      }),
    },
    ttl: {
      name: "ttl",
      clickhouseName: "expiration_ttl",
      ...column("String", {
        description: "The TTL string for expiration – by default dev runs have a TTL of '10m'.",
        example: "10m",
      }),
    },

    // Useful time periods
    execution_duration: {
      name: "execution_duration",
      ...column("Nullable(Int64)", {
        description:
          "The time between starting to execute and completing. This includes any time spent waiting (it is not compute time, use `usage_duration` for that).",
        customRenderType: "duration",
        example: "4000",
      }),
      expression: "dateDiff('millisecond', executed_at, completed_at)",
    },
    total_duration: {
      name: "total_duration",
      ...column("Nullable(Int64)", {
        description:
          "The time between being triggered and completing (if it has). This includes any time spent waiting (it is not compute time, use `usage_duration` for that).",
        customRenderType: "duration",
        example: "4000",
      }),
      expression: "dateDiff('millisecond', created_at, completed_at)",
    },
    queued_duration: {
      name: "queued_duration",
      ...column("Nullable(Int64)", {
        description:
          "The time between being queued and dequeued. Remember you need enough available concurrency for runs to be dequeued and start executing.",
        customRenderType: "duration",
        example: "4000",
      }),
      expression: "dateDiff('millisecond', queued_at, started_at)",
    },

    // Cost & usage
    usage_duration: {
      name: "usage_duration",
      clickhouseName: "usage_duration_ms",
      ...column("UInt32", {
        description: "Compute usage duration in milliseconds.",
        customRenderType: "duration",
        example: "3500",
      }),
    },
    compute_cost: {
      name: "compute_cost",
      ...column("Float64", {
        description: "Compute cost in dollars",
        customRenderType: "costInDollars",
        example: "0.000676",
      }),
      expression: "cost_in_cents / 100.0",
    },
    invocation_cost: {
      name: "invocation_cost",
      ...column("Float64", {
        description: "Invocation cost in dollars – the cost to start a run.",
        customRenderType: "costInDollars",
        example: "0.000025",
      }),
      expression: "base_cost_in_cents / 100.0",
    },
    total_cost: {
      name: "total_cost",
      ...column("Float64", {
        description: "Total cost in dollars (compute_cost + invocation_cost)",
        customRenderType: "costInDollars",
        example: "0.000701",
      }),
      expression: "(cost_in_cents + base_cost_in_cents) / 100.0",
    },

    // Output & error (JSON columns)
    // For JSON columns, NULL checks are transformed to check for empty object '{}'
    // So `error IS NULL` becomes `error = '{}'` and `error IS NOT NULL` becomes `error != '{}'`
    // textColumn uses the pre-materialized text columns for better performance
    // dataPrefix handles the internal {"data": ...} wrapper transparently
    output: {
      name: "output",
      ...column("JSON", {
        description: "The data you returned from the task.",
        example: '{"result": "success"}',
      }),
      nullValue: "'{}'", // Transform NULL checks to compare against empty object
      textColumn: "output_text", // Use output_text for full JSON value queries
      dataPrefix: "data", // Internal data is wrapped in {"data": ...}
    },
    error: {
      name: "error",
      ...column("JSON", {
        description:
          "If a run completely failed (after all attempts) then this error will be populated.",
        example: '{"message": "Task failed"}',
      }),
      nullValue: "'{}'", // Transform NULL checks to compare against empty object
      textColumn: "error_text", // Use error_text for full JSON value queries
      dataPrefix: "data", // Internal data is wrapped in {"data": ...}
    },

    // Tags & versions
    tags: {
      name: "tags",
      ...column("Array(String)", {
        description: "Tags you have added to the run.",
        customRenderType: "tags",
        example: '["user:123", "priority:high"]',
      }),
    },
    task_version: {
      name: "task_version",
      ...column("String", {
        description: "The version of your code in reverse date format.",
        example: "20240115.1",
      }),
    },
    sdk_version: {
      name: "sdk_version",
      ...column("String", {
        description: "The SDK package version for this run.",
        example: "3.3.0",
      }),
    },
    cli_version: {
      name: "cli_version",
      ...column("String", {
        description: "The CLI package version for this run.",
        example: "3.3.0",
      }),
    },
    machine: {
      name: "machine",
      clickhouseName: "machine_preset",
      ...column("LowCardinality(String)", {
        description: "The machine that the run executed on.",
        allowedValues: [...MACHINE_PRESETS],
        customRenderType: "machine",
        example: "small-1x",
      }),
    },
    is_test: {
      name: "is_test",
      ...column("UInt8", { description: "Whether this is a test run (0 or 1)", example: "0" }),
      expression: "if(is_test > 0, true, false)",
    },
    concurrency_key: {
      name: "concurrency_key",
      ...column("String", {
        description: "The concurrency key you passed in when triggering the run.",
        example: "user:1234567",
      }),
    },
    max_duration: {
      name: "max_duration",
      clickhouseName: "max_duration_in_seconds",
      ...column("Nullable(UInt32)", {
        description:
          "The maximum allowed compute duration for this run in seconds. If the run exceeds this duration, the run will fail with an error. Can be set on an individual task, in the trigger.config, or per-run when triggering.",
        example: "300",
        customRenderType: "durationSeconds",
      }),
    },
    bulk_action_group_ids: {
      name: "bulk_action_group_ids",
      ...column("Array(String)", {
        description: "Any bulk actions that operated on this run.",
        example: '["bulk_12345678", "bulk_34567890"]',
        whereTransform: (value: string) => {
          logger.log(`WHERE TRANSFORM: ${value}`);
          return value.replace(/^bulk_/, "");
        },
      }),
    },
  },
};

/**
 * All available schemas for the query editor
 */
export const querySchemas: TableSchema[] = [runsSchema];

/**
 * Default query for the query editor
 */
export const defaultQuery = autoFormatSQL(`SELECT run_id, task_identifier, triggered_at, status
FROM runs
ORDER BY triggered_at DESC
LIMIT 100`);
