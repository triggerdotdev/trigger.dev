import { randomUUID } from "crypto";
import { env as stdEnv } from "std-env";
import { z } from "zod";
import { AdditionalEnvVars, BoolEnv } from "./envUtil.js";

const Env = z.object({
  // This will come from `spec.nodeName` in k8s
  TRIGGER_WORKER_INSTANCE_NAME: z.string().default(randomUUID()),

  // Required settings
  TRIGGER_API_URL: z.string().url(),
  TRIGGER_WORKER_TOKEN: z.string(),
  MANAGED_WORKER_SECRET: z.string(),

  // Workload API settings (coordinator mode) - the workload API is what the run controller connects to
  TRIGGER_WORKLOAD_API_ENABLED: BoolEnv.default("true"),
  TRIGGER_WORKLOAD_API_PROTOCOL: z
    .string()
    .transform((s) => z.enum(["http", "https"]).parse(s.toLowerCase()))
    .default("http"),
  TRIGGER_WORKLOAD_API_DOMAIN: z.string().optional(), // If unset, will use orchestrator-specific default
  TRIGGER_WORKLOAD_API_HOST_INTERNAL: z.string().default("0.0.0.0"),
  TRIGGER_WORKLOAD_API_PORT_INTERNAL: z.coerce.number().default(8020), // This is the port the workload API listens on
  TRIGGER_WORKLOAD_API_PORT_EXTERNAL: z.coerce.number().default(8020), // This is the exposed port passed to the run controller

  // Runner settings
  RUNNER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().optional(),
  RUNNER_SNAPSHOT_POLL_INTERVAL_SECONDS: z.coerce.number().optional(),
  RUNNER_ADDITIONAL_ENV_VARS: AdditionalEnvVars, // optional (csv)
  RUNNER_DOCKER_AUTOREMOVE: BoolEnv.default(true),

  // Dequeue settings (provider mode)
  TRIGGER_DEQUEUE_ENABLED: BoolEnv.default("true"),
  TRIGGER_DEQUEUE_INTERVAL_MS: z.coerce.number().int().default(1000),
  TRIGGER_DEQUEUE_MAX_RUN_COUNT: z.coerce.number().int().default(10),

  // Optional services
  TRIGGER_WARM_START_URL: z.string().optional(),
  TRIGGER_CHECKPOINT_URL: z.string().optional(),
  TRIGGER_METADATA_URL: z.string().optional(),

  // Used by the workload manager, e.g docker/k8s
  DOCKER_NETWORK: z.string().default("host"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(),
  ENFORCE_MACHINE_PRESETS: z.coerce.boolean().default(false),
  KUBERNETES_IMAGE_PULL_SECRETS: z.string().optional(), // csv

  // Used by the resource monitor
  OVERRIDE_CPU_TOTAL: z.coerce.number().optional(),
  OVERRIDE_MEMORY_TOTAL_GB: z.coerce.number().optional(),

  // Kubernetes specific settings
  KUBERNETES_FORCE_ENABLED: BoolEnv.default(false),
  KUBERNETES_NAMESPACE: z.string().default("default"),
  KUBERNETES_WORKER_NODETYPE_LABEL: z.string().default("v4-worker"),
  EPHEMERAL_STORAGE_SIZE_LIMIT: z.string().default("10Gi"),
  EPHEMERAL_STORAGE_SIZE_REQUEST: z.string().default("2Gi"),

  // Metrics
  METRICS_ENABLED: BoolEnv.default(true),
  METRICS_COLLECT_DEFAULTS: BoolEnv.default(true),
  METRICS_HOST: z.string().default("127.0.0.1"),
  METRICS_PORT: z.coerce.number().int().default(9090),

  // Pod cleaner
  POD_CLEANER_ENABLED: BoolEnv.default(true),
  POD_CLEANER_INTERVAL_MS: z.coerce.number().int().default(10000),
  POD_CLEANER_BATCH_SIZE: z.coerce.number().int().default(500),

  // Failed pod handler
  FAILED_POD_HANDLER_ENABLED: BoolEnv.default(true),
  FAILED_POD_HANDLER_RECONNECT_INTERVAL_MS: z.coerce.number().int().default(1000),

  // Debug
  DEBUG: BoolEnv.default(false),
});

export const env = Env.parse(stdEnv);
