import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import {
  type WorkloadManager,
  type WorkloadManagerCreateOptions,
  type WorkloadManagerOptions,
} from "./types.js";
import { env } from "../env.js";
import { getRunnerId } from "../util.js";
import { tryCatch } from "@trigger.dev/core";

type ComputeWorkloadManagerOptions = WorkloadManagerOptions & {
  gatewayUrl: string;
  gatewayAuthToken?: string;
};

export class ComputeWorkloadManager implements WorkloadManager {
  private readonly logger = new SimpleStructuredLogger("compute-workload-manager");

  constructor(private opts: ComputeWorkloadManagerOptions) {
    if (!opts.workloadApiDomain) {
      this.logger.warn(
        "⚠️ workloadApiDomain is unset — VMs need an explicit host IP to reach the supervisor"
      );
    }
  }

  async create(opts: WorkloadManagerCreateOptions) {
    this.logger.log("create()", { opts });

    const runnerId = getRunnerId(opts.runFriendlyId, opts.nextAttemptNumber);

    const envVars: Record<string, string> = {
      OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT,
      TRIGGER_DEQUEUED_AT_MS: String(opts.dequeuedAt.getTime()),
      TRIGGER_POD_SCHEDULED_AT_MS: String(Date.now()),
      TRIGGER_ENV_ID: opts.envId,
      TRIGGER_DEPLOYMENT_ID: opts.deploymentFriendlyId,
      TRIGGER_DEPLOYMENT_VERSION: opts.deploymentVersion,
      TRIGGER_RUN_ID: opts.runFriendlyId,
      TRIGGER_SNAPSHOT_ID: opts.snapshotFriendlyId,
      TRIGGER_SUPERVISOR_API_PROTOCOL: this.opts.workloadApiProtocol,
      TRIGGER_SUPERVISOR_API_PORT: String(this.opts.workloadApiPort),
      TRIGGER_SUPERVISOR_API_DOMAIN: this.opts.workloadApiDomain ?? "",
      TRIGGER_WORKER_INSTANCE_NAME: env.TRIGGER_WORKER_INSTANCE_NAME,
      TRIGGER_RUNNER_ID: runnerId,
      TRIGGER_MACHINE_CPU: String(opts.machine.cpu),
      TRIGGER_MACHINE_MEMORY: String(opts.machine.memory),
      PRETTY_LOGS: String(env.RUNNER_PRETTY_LOGS),
    };

    if (this.opts.warmStartUrl) {
      envVars.TRIGGER_WARM_START_URL = this.opts.warmStartUrl;
    }

    if (this.opts.metadataUrl) {
      envVars.TRIGGER_METADATA_URL = this.opts.metadataUrl;
    }

    if (this.opts.heartbeatIntervalSeconds) {
      envVars.TRIGGER_HEARTBEAT_INTERVAL_SECONDS = String(this.opts.heartbeatIntervalSeconds);
    }

    if (this.opts.snapshotPollIntervalSeconds) {
      envVars.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS = String(this.opts.snapshotPollIntervalSeconds);
    }

    if (this.opts.additionalEnvVars) {
      Object.assign(envVars, this.opts.additionalEnvVars);
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.opts.gatewayAuthToken) {
      headers["Authorization"] = `Bearer ${this.opts.gatewayAuthToken}`;
    }

    const url = `${this.opts.gatewayUrl}/api/sandboxes`;

    const [fetchError, response] = await tryCatch(
      fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          image: opts.image,
          env: envVars,
        }),
      })
    );

    if (fetchError) {
      this.logger.error("Failed to create sandbox", { error: fetchError, url });
      return;
    }

    if (!response.ok) {
      const [bodyError, body] = await tryCatch(response.text());
      this.logger.error("Gateway returned error", {
        status: response.status,
        body: bodyError ? undefined : body,
        url,
      });
      return;
    }

    const [parseError, data] = await tryCatch(response.json());

    if (parseError) {
      this.logger.error("Failed to parse gateway response", { error: parseError });
      return;
    }

    this.logger.debug("create succeeded", { sandboxId: data.id, runnerId });
  }
}
