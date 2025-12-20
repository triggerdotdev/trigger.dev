import { column, type TableSchema } from "@internal/tsql";
import { runFriendlyStatus, runStatusTitleFromStatus } from "~/components/runs/v3/TaskRunStatus";

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
  columns: {
    run_id: {
      name: "run_id",
      clickhouseName: "friendly_id",
      ...column("String", {
        description:
          "A unique ID for a run. They always start with `run_`, e.g., run_cm1a2b3c4d5e6f7g8h9i",
        customRenderType: "runId",
        example: "run_cm1a2b3c4d5e6f7g8h9i",
      }),
    },
    environment_id: {
      name: "environment_id",
      ...column("String", { description: "Environment ID", example: "cm1a2b3c4d5e6f7g8h9i" }),
    },
    organization_id: {
      name: "organization_id",
      ...column("String", { description: "Organization ID", example: "cm9z8y7x6w5v4u3t2s1r" }),
    },
    project_id: {
      name: "project_id",
      ...column("String", { description: "Project ID", example: "cm2b3c4d5e6f7g8h9i0j" }),
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
    attempt: {
      name: "attempt",
      ...column("UInt8", { description: "Number of attempts (starts at 1)", example: "1" }),
    },
    status: {
      name: "status",
      ...column("LowCardinality(String)", {
        description: "Run status",
        allowedValues: [...runFriendlyStatus],
        valueMap: runStatusTitleFromStatus,
        customRenderType: "runStatus",
        example: "Completed",
      }),
    },

    // Task & queue
    task_identifier: {
      name: "task_identifier",
      ...column("String", { description: "Task identifier/slug", example: "my-background-task" }),
    },
    queue: {
      name: "queue",
      ...column("String", { description: "Queue name", example: "task/my-background-task" }),
    },
    schedule_id: {
      name: "schedule_id",
      ...column("String", {
        description: "Schedule ID (if triggered by schedule)",
        example: "sched_1234abcd",
      }),
    },
    batch_id: {
      name: "batch_id",
      ...column("String", {
        description: "Batch ID (if part of a batch)",
        example: "batch_5678efgh",
      }),
    },

    // Related runs
    root_run_id: {
      name: "root_run_id",
      ...column("String", {
        description: "Root run ID (for child runs)",
        example: "run_root1234abcd",
      }),
    },
    parent_run_id: {
      name: "parent_run_id",
      ...column("String", {
        description: "Parent run ID (for child runs)",
        example: "run_parent5678ef",
      }),
    },
    depth: {
      name: "depth",
      ...column("UInt8", { description: "Nesting depth (0 for root runs)", example: "0" }),
    },

    // Telemetry
    span_id: {
      name: "span_id",
      ...column("String", { description: "OpenTelemetry span ID", example: "a1b2c3d4e5f6g7h8" }),
    },
    trace_id: {
      name: "trace_id",
      ...column("String", {
        description: "OpenTelemetry trace ID",
        example: "abc123def456ghi789jkl012mno345pq",
      }),
    },
    idempotency_key: {
      name: "idempotency_key",
      ...column("String", { description: "Idempotency key", example: "user-123-action-456" }),
    },
    region: {
      name: "region",
      clickhouseName: "region",
      ...column("String", { description: "Region", example: "us-east-1" }),
    },

    // Timing
    created_at: {
      name: "created_at",
      ...column("DateTime64", {
        description: "When the run was created",
        example: "2024-01-15 09:30:00.000",
      }),
    },
    updated_at: {
      name: "updated_at",
      ...column("DateTime64", {
        description: "When the run was last updated",
        example: "2024-01-15 09:30:05.123",
      }),
    },
    started_at: {
      name: "started_at",
      ...column("Nullable(DateTime64)", {
        description: "When the run started executing",
        example: "2024-01-15 09:30:01.000",
      }),
    },
    executed_at: {
      name: "executed_at",
      ...column("Nullable(DateTime64)", {
        description: "When execution began",
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
    queued_at: {
      name: "queued_at",
      ...column("Nullable(DateTime64)", {
        description: "When the run was queued",
        example: "2024-01-15 09:30:00.500",
      }),
    },
    expired_at: {
      name: "expired_at",
      ...column("Nullable(DateTime64)", {
        description: "When the run expired",
        example: "2024-01-15 09:35:00.000",
      }),
    },
    expiration_ttl: {
      name: "expiration_ttl",
      ...column("String", { description: "TTL string for expiration", example: "5m" }),
    },

    // Cost & usage
    usage_duration: {
      name: "usage_duration",
      clickhouseName: "usage_duration_ms",
      ...column("UInt32", {
        description: "Usage duration in milliseconds",
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
        description: "Invocation cost in dollars",
        customRenderType: "costInDollars",
        example: "0.000025",
      }),
      expression: "base_cost_in_cents / 100.0",
    },

    // Output & error (JSON columns)
    output: {
      name: "output",
      ...column("JSON", { description: "Run output data", example: '{"result": "success"}' }),
    },
    error: {
      name: "error",
      ...column("JSON", {
        description: "Error information",
        example: '{"message": "Task failed"}',
      }),
    },

    // Tags & versions
    tags: {
      name: "tags",
      ...column("Array(String)", {
        description: "Run tags",
        customRenderType: "tags",
        example: '["user:123", "priority:high"]',
      }),
    },
    task_version: {
      name: "task_version",
      ...column("String", { description: "Task version", example: "20240115.1" }),
    },
    sdk_version: {
      name: "sdk_version",
      ...column("String", { description: "SDK version", example: "3.3.0" }),
    },
    cli_version: {
      name: "cli_version",
      ...column("String", { description: "CLI version", example: "3.3.0" }),
    },
    machine: {
      name: "machine",
      clickhouseName: "machine_preset",
      ...column("LowCardinality(String)", {
        description: "Machine preset",
        allowedValues: [...MACHINE_PRESETS],
        customRenderType: "machine",
        example: "small-1x",
      }),
    },

    // Flags
    is_test: {
      name: "is_test",
      ...column("UInt8", { description: "Whether this is a test run (0 or 1)", example: "0" }),
    },

    // Virtual columns
    execution_duration: {
      name: "execution_duration",
      ...column("Nullable(Int64)", {
        description:
          "The time between the run starting and completing. This includes any time spent waiting (it is not compute time, use `usage_duration` for that).",
        customRenderType: "duration",
        example: "4000",
      }),
      expression: "dateDiff('millisecond', started_at, completed_at)",
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
export const defaultQuery = `SELECT
  run_id,
  task_identifier,
  status,
  created_at,
  usage_duration,
  compute_cost,
  invocation_cost,
  machine,
FROM runs
ORDER BY created_at DESC
LIMIT 10`;
