import { column, type TableSchema } from "@internal/tsql";
import { runFriendlyStatus, runStatusTitleFromStatus } from "~/components/runs/v3/TaskRunStatus";

/**
 * Environment type values
 */
const ENVIRONMENT_TYPES = ["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"] as const;

/**
 * Engine type values
 */
const ENGINE_TYPES = ["V1", "V2"] as const;

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
    // IDs & hierarchy
    run_id: {
      name: "run_id",
      ...column("String", { description: "Unique run identifier" }),
    },
    friendly_id: {
      name: "friendly_id",
      ...column("String", { description: "Human-readable run ID (e.g., run_abc123)" }),
    },
    environment_id: {
      name: "environment_id",
      ...column("String", { description: "Environment ID" }),
    },
    organization_id: {
      name: "organization_id",
      ...column("String", { description: "Organization ID" }),
    },
    project_id: {
      name: "project_id",
      ...column("String", { description: "Project ID" }),
    },
    environment_type: {
      name: "environment_type",
      ...column("LowCardinality(String)", {
        description: "Environment type",
        allowedValues: [...ENVIRONMENT_TYPES],
      }),
    },
    attempt: {
      name: "attempt",
      ...column("UInt8", { description: "Attempt number (starts at 1)" }),
    },

    // Status & engine
    engine: {
      name: "engine",
      ...column("LowCardinality(String)", {
        description: "Run engine version",
        allowedValues: [...ENGINE_TYPES],
      }),
    },
    status: {
      name: "status",
      ...column("LowCardinality(String)", {
        description: "Run status",
        allowedValues: [...runFriendlyStatus],
        valueMap: runStatusTitleFromStatus,
      }),
    },

    // Task & queue
    task_identifier: {
      name: "task_identifier",
      ...column("String", { description: "Task identifier/slug" }),
    },
    queue: {
      name: "queue",
      ...column("String", { description: "Queue name" }),
    },
    schedule_id: {
      name: "schedule_id",
      ...column("String", { description: "Schedule ID (if triggered by schedule)" }),
    },
    batch_id: {
      name: "batch_id",
      ...column("String", { description: "Batch ID (if part of a batch)" }),
    },

    // Related runs
    root_run_id: {
      name: "root_run_id",
      ...column("String", { description: "Root run ID (for child runs)" }),
    },
    parent_run_id: {
      name: "parent_run_id",
      ...column("String", { description: "Parent run ID (for child runs)" }),
    },
    depth: {
      name: "depth",
      ...column("UInt8", { description: "Nesting depth (0 for root runs)" }),
    },

    // Telemetry
    span_id: {
      name: "span_id",
      ...column("String", { description: "OpenTelemetry span ID" }),
    },
    trace_id: {
      name: "trace_id",
      ...column("String", { description: "OpenTelemetry trace ID" }),
    },
    idempotency_key: {
      name: "idempotency_key",
      ...column("String", { description: "Idempotency key" }),
    },

    // Timing
    created_at: {
      name: "created_at",
      ...column("DateTime64", { description: "When the run was created" }),
    },
    updated_at: {
      name: "updated_at",
      ...column("DateTime64", { description: "When the run was last updated" }),
    },
    started_at: {
      name: "started_at",
      ...column("Nullable(DateTime64)", { description: "When the run started executing" }),
    },
    executed_at: {
      name: "executed_at",
      ...column("Nullable(DateTime64)", { description: "When execution began" }),
    },
    completed_at: {
      name: "completed_at",
      ...column("Nullable(DateTime64)", { description: "When the run completed" }),
    },
    delay_until: {
      name: "delay_until",
      ...column("Nullable(DateTime64)", { description: "Delayed execution until this time" }),
    },
    queued_at: {
      name: "queued_at",
      ...column("Nullable(DateTime64)", { description: "When the run was queued" }),
    },
    expired_at: {
      name: "expired_at",
      ...column("Nullable(DateTime64)", { description: "When the run expired" }),
    },
    expiration_ttl: {
      name: "expiration_ttl",
      ...column("String", { description: "TTL string for expiration" }),
    },

    // Cost & usage
    usage_duration_ms: {
      name: "usage_duration_ms",
      ...column("UInt32", { description: "Usage duration in milliseconds" }),
    },
    cost_in_cents: {
      name: "cost_in_cents",
      ...column("Float64", { description: "Cost in cents" }),
    },
    base_cost_in_cents: {
      name: "base_cost_in_cents",
      ...column("Float64", { description: "Base cost in cents" }),
    },

    // Output & error (JSON columns)
    output: {
      name: "output",
      ...column("JSON", { description: "Run output data" }),
    },
    error: {
      name: "error",
      ...column("JSON", { description: "Error information" }),
    },

    // Tags & versions
    tags: {
      name: "tags",
      ...column("Array(String)", { description: "Run tags" }),
    },
    task_version: {
      name: "task_version",
      ...column("String", { description: "Task version" }),
    },
    sdk_version: {
      name: "sdk_version",
      ...column("String", { description: "SDK version" }),
    },
    cli_version: {
      name: "cli_version",
      ...column("String", { description: "CLI version" }),
    },
    machine_preset: {
      name: "machine_preset",
      ...column("LowCardinality(String)", {
        description: "Machine preset",
        allowedValues: [...MACHINE_PRESETS],
      }),
    },

    // Flags
    is_test: {
      name: "is_test",
      ...column("UInt8", { description: "Whether this is a test run (0 or 1)" }),
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
  friendly_id,
  task_identifier,
  status,
  created_at,
  usage_duration_ms
FROM runs
ORDER BY created_at DESC
LIMIT 10`;
