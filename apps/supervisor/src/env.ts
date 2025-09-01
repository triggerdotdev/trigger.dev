import { randomUUID } from "crypto";
import { env as stdEnv } from "std-env";
import { z } from "zod";
import { AdditionalEnvVars, BoolEnv } from "./envUtil.js";

const Env = z.object({
  // This will come from `spec.nodeName` in k8s
  TRIGGER_WORKER_INSTANCE_NAME: z.string().default(randomUUID()),
  TRIGGER_WORKER_HEARTBEAT_INTERVAL_SECONDS: z.coerce.number().default(30),

  // Required settings
  TRIGGER_API_URL: z.string().url(),
  TRIGGER_WORKER_TOKEN: z.string(), // accepts file:// path to read from a file
  MANAGED_WORKER_SECRET: z.string(),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(), // set on the runners

  // Workload API settings (coordinator mode) - the workload API is what the run controller connects to
  TRIGGER_WORKLOAD_API_ENABLED: BoolEnv.default(true),
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
  RUNNER_PRETTY_LOGS: BoolEnv.default(false),

  // Dequeue settings (provider mode)
  TRIGGER_DEQUEUE_ENABLED: BoolEnv.default(true),
  TRIGGER_DEQUEUE_INTERVAL_MS: z.coerce.number().int().default(250),
  TRIGGER_DEQUEUE_IDLE_INTERVAL_MS: z.coerce.number().int().default(1000),
  TRIGGER_DEQUEUE_MAX_RUN_COUNT: z.coerce.number().int().default(1),
  TRIGGER_DEQUEUE_MIN_CONSUMER_COUNT: z.coerce.number().int().default(1),
  TRIGGER_DEQUEUE_MAX_CONSUMER_COUNT: z.coerce.number().int().default(10),
  TRIGGER_DEQUEUE_SCALING_STRATEGY: z.enum(["none", "smooth", "aggressive"]).default("none"),
  TRIGGER_DEQUEUE_SCALING_UP_COOLDOWN_MS: z.coerce.number().int().default(10000), // 10 seconds
  TRIGGER_DEQUEUE_SCALING_DOWN_COOLDOWN_MS: z.coerce.number().int().default(60000), // 60 seconds
  TRIGGER_DEQUEUE_SCALING_TARGET_RATIO: z.coerce.number().default(1.0), // Target ratio of queue items to consumers (1.0 = 1 item per consumer)
  TRIGGER_DEQUEUE_SCALING_EWMA_ALPHA: z.coerce.number().min(0).max(1).default(0.3), // EWMA smoothing factor (0-1)
  TRIGGER_DEQUEUE_SCALING_BATCH_WINDOW_MS: z.coerce.number().int().positive().default(1000), // Batch window for metrics processing (ms)

  // Optional services
  TRIGGER_WARM_START_URL: z.string().optional(),
  TRIGGER_CHECKPOINT_URL: z.string().optional(),
  TRIGGER_METADATA_URL: z.string().optional(),

  // Used by the resource monitor
  RESOURCE_MONITOR_ENABLED: BoolEnv.default(false),
  RESOURCE_MONITOR_OVERRIDE_CPU_TOTAL: z.coerce.number().optional(),
  RESOURCE_MONITOR_OVERRIDE_MEMORY_TOTAL_GB: z.coerce.number().optional(),

  // Docker settings
  DOCKER_API_VERSION: z.string().default("v1.41"),
  DOCKER_PLATFORM: z.string().optional(), // e.g. linux/amd64, linux/arm64
  DOCKER_STRIP_IMAGE_DIGEST: BoolEnv.default(true),
  DOCKER_REGISTRY_USERNAME: z.string().optional(),
  DOCKER_REGISTRY_PASSWORD: z.string().optional(),
  DOCKER_REGISTRY_URL: z.string().optional(), // e.g. https://index.docker.io/v1
  DOCKER_ENFORCE_MACHINE_PRESETS: BoolEnv.default(true),
  DOCKER_AUTOREMOVE_EXITED_CONTAINERS: BoolEnv.default(true),
  /**
   * Network mode to use for all runners. Supported standard values are: `bridge`, `host`, `none`, and `container:<name|id>`.
   * Any other value is taken as a custom network's name to which all runners should connect to.
   *
   * Accepts a list of comma-separated values to attach to multiple networks. Additional networks are interpreted as network names and will be attached after container creation.
   *
   * **WARNING**: Specifying multiple networks will slightly increase startup times.
   *
   * @default "host"
   */
  DOCKER_RUNNER_NETWORKS: z.string().default("host"),

  // Kubernetes settings
  KUBERNETES_FORCE_ENABLED: BoolEnv.default(false),
  KUBERNETES_NAMESPACE: z.string().default("default"),
  KUBERNETES_WORKER_NODETYPE_LABEL: z.string().default("v4-worker"),
  KUBERNETES_IMAGE_PULL_SECRETS: z.string().optional(), // csv
  KUBERNETES_EPHEMERAL_STORAGE_SIZE_LIMIT: z.string().default("10Gi"),
  KUBERNETES_EPHEMERAL_STORAGE_SIZE_REQUEST: z.string().default("2Gi"),
  KUBERNETES_STRIP_IMAGE_DIGEST: BoolEnv.default(false),

  // Placement tags settings
  PLACEMENT_TAGS_ENABLED: BoolEnv.default(false),
  PLACEMENT_TAGS_PREFIX: z.string().default("node.cluster.x-k8s.io"),

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
  SEND_RUN_DEBUG_LOGS: BoolEnv.default(false),
});

export const env = Env.parse(stdEnv);
