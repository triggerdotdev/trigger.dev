import { randomUUID } from "crypto";
import { env as stdEnv } from "std-env";
import { z } from "zod";

const Env = z.object({
  // This will come from `spec.nodeName` in k8s
  TRIGGER_WORKER_INSTANCE_NAME: z.string().default(randomUUID()),

  // Required settings
  TRIGGER_API_URL: z.string().url(),
  TRIGGER_WORKER_TOKEN: z.string(),
  MANAGED_WORKER_SECRET: z.string(),

  // Workload API settings (coordinator mode) - the workload API is what the run controller connects to
  TRIGGER_WORKLOAD_API_ENABLED: z.coerce.boolean().default(true),
  TRIGGER_WORKLOAD_API_PROTOCOL: z
    .string()
    .transform((s) => z.enum(["http", "https"]).parse(s.toLowerCase()))
    .default("http"),
  TRIGGER_WORKLOAD_API_DOMAIN: z.string().optional(), // If unset, will use orchestrator-specific default
  TRIGGER_WORKLOAD_API_PORT_INTERNAL: z.coerce.number().default(8020), // This is the port the workload API listens on
  TRIGGER_WORKLOAD_API_PORT_EXTERNAL: z.coerce.number().default(8020), // This is the exposed port passed to the run controller

  // Dequeue settings (provider mode)
  TRIGGER_DEQUEUE_ENABLED: z.coerce.boolean().default(true),
  TRIGGER_DEQUEUE_INTERVAL_MS: z.coerce.number().int().default(1000),

  // Optional services
  TRIGGER_WARM_START_URL: z.string().optional(),
  TRIGGER_CHECKPOINT_URL: z.string().optional(),

  // Used by the workload manager, e.g docker/k8s
  DOCKER_NETWORK: z.string().default("host"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(),
  ENFORCE_MACHINE_PRESETS: z.coerce.boolean().default(false),

  // Used by the resource monitor
  OVERRIDE_CPU_TOTAL: z.coerce.number().optional(),
  OVERRIDE_MEMORY_TOTAL_GB: z.coerce.number().optional(),
});

export const env = Env.parse(stdEnv);
