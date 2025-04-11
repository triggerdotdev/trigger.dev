import { randomUUID } from "node:crypto";
import { Metadata } from "./overrides.js";
import { z } from "zod";

const DateEnv = z
  .string()
  .transform((val) => new Date(parseInt(val, 10)))
  .pipe(z.date());

// All IDs are friendly IDs
const Env = z.object({
  // Set at build time
  TRIGGER_CONTENT_HASH: z.string(),
  TRIGGER_DEPLOYMENT_ID: z.string(),
  TRIGGER_DEPLOYMENT_VERSION: z.string(),
  TRIGGER_PROJECT_ID: z.string(),
  TRIGGER_PROJECT_REF: z.string(),
  NODE_ENV: z.string().default("production"),
  NODE_EXTRA_CA_CERTS: z.string().optional(),

  // Set at runtime
  TRIGGER_WORKLOAD_CONTROLLER_ID: z.string().default(`controller_${randomUUID()}`),
  TRIGGER_ENV_ID: z.string(),
  TRIGGER_RUN_ID: z.string().optional(), // This is only useful for cold starts
  TRIGGER_SNAPSHOT_ID: z.string().optional(), // This is only useful for cold starts
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(),
  TRIGGER_WARM_START_URL: z.string().optional(),
  TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS: z.coerce.number().default(30_000),
  TRIGGER_WARM_START_KEEPALIVE_MS: z.coerce.number().default(300_000),
  TRIGGER_MACHINE_CPU: z.string().default("0"),
  TRIGGER_MACHINE_MEMORY: z.string().default("0"),
  TRIGGER_RUNNER_ID: z.string(),
  TRIGGER_METADATA_URL: z.string().optional(),
  TRIGGER_PRE_SUSPEND_WAIT_MS: z.coerce.number().default(200),

  // Timeline metrics
  TRIGGER_POD_SCHEDULED_AT_MS: DateEnv,
  TRIGGER_DEQUEUED_AT_MS: DateEnv,

  // May be overridden
  TRIGGER_SUPERVISOR_API_PROTOCOL: z.enum(["http", "https"]),
  TRIGGER_SUPERVISOR_API_DOMAIN: z.string(),
  TRIGGER_SUPERVISOR_API_PORT: z.coerce.number(),
  TRIGGER_WORKER_INSTANCE_NAME: z.string(),
  TRIGGER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().default(30),
  TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS: z.coerce.number().default(5),
  TRIGGER_SUCCESS_EXIT_CODE: z.coerce.number().default(0),
  TRIGGER_FAILURE_EXIT_CODE: z.coerce.number().default(1),
});

type Env = z.infer<typeof Env>;

export class RunnerEnv {
  private env: Env;
  public readonly initial: Env;

  constructor(env: Record<string, string | undefined>) {
    this.env = Env.parse(env);
    this.initial = { ...this.env };
  }

  get raw() {
    return this.env;
  }

  // Base environment variables
  get NODE_ENV() {
    return this.env.NODE_ENV;
  }
  get NODE_EXTRA_CA_CERTS() {
    return this.env.NODE_EXTRA_CA_CERTS;
  }
  get OTEL_EXPORTER_OTLP_ENDPOINT() {
    return this.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  }
  get TRIGGER_CONTENT_HASH() {
    return this.env.TRIGGER_CONTENT_HASH;
  }
  get TRIGGER_DEPLOYMENT_ID() {
    return this.env.TRIGGER_DEPLOYMENT_ID;
  }
  get TRIGGER_DEPLOYMENT_VERSION() {
    return this.env.TRIGGER_DEPLOYMENT_VERSION;
  }
  get TRIGGER_PROJECT_ID() {
    return this.env.TRIGGER_PROJECT_ID;
  }
  get TRIGGER_PROJECT_REF() {
    return this.env.TRIGGER_PROJECT_REF;
  }
  get TRIGGER_WORKLOAD_CONTROLLER_ID() {
    return this.env.TRIGGER_WORKLOAD_CONTROLLER_ID;
  }
  get TRIGGER_ENV_ID() {
    return this.env.TRIGGER_ENV_ID;
  }
  get TRIGGER_RUN_ID() {
    return this.env.TRIGGER_RUN_ID;
  }
  get TRIGGER_SNAPSHOT_ID() {
    return this.env.TRIGGER_SNAPSHOT_ID;
  }
  get TRIGGER_WARM_START_URL() {
    return this.env.TRIGGER_WARM_START_URL;
  }
  get TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS() {
    return this.env.TRIGGER_WARM_START_CONNECTION_TIMEOUT_MS;
  }
  get TRIGGER_WARM_START_KEEPALIVE_MS() {
    return this.env.TRIGGER_WARM_START_KEEPALIVE_MS;
  }
  get TRIGGER_MACHINE_CPU() {
    return this.env.TRIGGER_MACHINE_CPU;
  }
  get TRIGGER_MACHINE_MEMORY() {
    return this.env.TRIGGER_MACHINE_MEMORY;
  }
  get TRIGGER_METADATA_URL() {
    return this.env.TRIGGER_METADATA_URL;
  }
  get TRIGGER_PRE_SUSPEND_WAIT_MS() {
    return this.env.TRIGGER_PRE_SUSPEND_WAIT_MS;
  }
  get TRIGGER_POD_SCHEDULED_AT_MS() {
    return this.env.TRIGGER_POD_SCHEDULED_AT_MS;
  }
  get TRIGGER_DEQUEUED_AT_MS() {
    return this.env.TRIGGER_DEQUEUED_AT_MS;
  }

  // Overridable values
  get TRIGGER_SUCCESS_EXIT_CODE() {
    return this.env.TRIGGER_SUCCESS_EXIT_CODE;
  }
  get TRIGGER_FAILURE_EXIT_CODE() {
    return this.env.TRIGGER_FAILURE_EXIT_CODE;
  }
  get TRIGGER_HEARTBEAT_INTERVAL_SECONDS() {
    return this.env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS;
  }
  get TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS() {
    return this.env.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS;
  }
  get TRIGGER_WORKER_INSTANCE_NAME() {
    return this.env.TRIGGER_WORKER_INSTANCE_NAME;
  }
  get TRIGGER_RUNNER_ID() {
    return this.env.TRIGGER_RUNNER_ID;
  }

  get TRIGGER_SUPERVISOR_API_PROTOCOL() {
    return this.env.TRIGGER_SUPERVISOR_API_PROTOCOL;
  }

  get TRIGGER_SUPERVISOR_API_DOMAIN() {
    return this.env.TRIGGER_SUPERVISOR_API_DOMAIN;
  }

  get TRIGGER_SUPERVISOR_API_PORT() {
    return this.env.TRIGGER_SUPERVISOR_API_PORT;
  }

  get TRIGGER_SUPERVISOR_API_URL() {
    return `${this.TRIGGER_SUPERVISOR_API_PROTOCOL}://${this.TRIGGER_SUPERVISOR_API_DOMAIN}:${this.TRIGGER_SUPERVISOR_API_PORT}`;
  }

  /** Overrides existing env vars with new values */
  override(overrides: Metadata) {
    if (overrides.TRIGGER_SUCCESS_EXIT_CODE) {
      this.env.TRIGGER_SUCCESS_EXIT_CODE = overrides.TRIGGER_SUCCESS_EXIT_CODE;
    }

    if (overrides.TRIGGER_FAILURE_EXIT_CODE) {
      this.env.TRIGGER_FAILURE_EXIT_CODE = overrides.TRIGGER_FAILURE_EXIT_CODE;
    }

    if (overrides.TRIGGER_HEARTBEAT_INTERVAL_SECONDS) {
      this.env.TRIGGER_HEARTBEAT_INTERVAL_SECONDS = overrides.TRIGGER_HEARTBEAT_INTERVAL_SECONDS;
    }

    if (overrides.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS) {
      this.env.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS =
        overrides.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS;
    }

    if (overrides.TRIGGER_WORKER_INSTANCE_NAME) {
      this.env.TRIGGER_WORKER_INSTANCE_NAME = overrides.TRIGGER_WORKER_INSTANCE_NAME;
    }

    if (overrides.TRIGGER_SUPERVISOR_API_PROTOCOL) {
      this.env.TRIGGER_SUPERVISOR_API_PROTOCOL = overrides.TRIGGER_SUPERVISOR_API_PROTOCOL as
        | "http"
        | "https";
    }

    if (overrides.TRIGGER_SUPERVISOR_API_DOMAIN) {
      this.env.TRIGGER_SUPERVISOR_API_DOMAIN = overrides.TRIGGER_SUPERVISOR_API_DOMAIN;
    }

    if (overrides.TRIGGER_SUPERVISOR_API_PORT) {
      this.env.TRIGGER_SUPERVISOR_API_PORT = overrides.TRIGGER_SUPERVISOR_API_PORT;
    }

    if (overrides.TRIGGER_RUNNER_ID) {
      this.env.TRIGGER_RUNNER_ID = overrides.TRIGGER_RUNNER_ID;
    }
  }

  // Helper method to get process env for task runs
  gatherProcessEnv(): Record<string, string> {
    const $env = {
      NODE_ENV: this.NODE_ENV,
      NODE_EXTRA_CA_CERTS: this.NODE_EXTRA_CA_CERTS,
      OTEL_EXPORTER_OTLP_ENDPOINT: this.OTEL_EXPORTER_OTLP_ENDPOINT,
    };

    // Filter out undefined values
    return Object.fromEntries(
      Object.entries($env).filter(([key, value]) => value !== undefined)
    ) as Record<string, string>;
  }
}
