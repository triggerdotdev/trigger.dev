import { randomUUID } from "crypto";
import { env as stdEnv } from "std-env";
import { z } from "zod";
import { getDockerHostDomain } from "./util.js";

const Env = z.object({
  // This will come from `status.hostIP` in k8s
  WORKER_HOST_IP: z.string().default(getDockerHostDomain()),
  TRIGGER_API_URL: z.string().url(),
  TRIGGER_WORKER_TOKEN: z.string(),
  // This will come from `spec.nodeName` in k8s
  TRIGGER_WORKER_INSTANCE_NAME: z.string().default(randomUUID()),
  MANAGED_WORKER_SECRET: z.string(),
  TRIGGER_WORKLOAD_API_PORT: z.coerce.number().default(8020),
  TRIGGER_WORKLOAD_API_PORT_EXTERNAL: z.coerce.number().default(8020),
  TRIGGER_WARM_START_URL: z.string().optional(),
  TRIGGER_CHECKPOINT_URL: z.string().optional(),
  TRIGGER_DEQUEUE_INTERVAL_MS: z.coerce.number().int().default(1000),

  // Used by the workload manager, e.g docker/k8s
  DOCKER_NETWORK: z.string().default("host"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url(),
  ENFORCE_MACHINE_PRESETS: z.coerce.boolean().default(false),

  // Used by the resource monitor
  OVERRIDE_CPU_TOTAL: z.coerce.number().optional(),
  OVERRIDE_MEMORY_TOTAL_GB: z.coerce.number().optional(),
});

export const env = Env.parse(stdEnv);
