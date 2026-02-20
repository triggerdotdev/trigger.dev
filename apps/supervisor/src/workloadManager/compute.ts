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
  gatewayTimeoutMs: number;
};

export class ComputeWorkloadManager implements WorkloadManager {
  private readonly logger = new SimpleStructuredLogger("compute-workload-manager");

  constructor(private opts: ComputeWorkloadManagerOptions) {
    if (opts.workloadApiDomain) {
      this.logger.warn("⚠️ Custom workload API domain", {
        domain: opts.workloadApiDomain,
      });
    }
  }

  async create(opts: WorkloadManagerCreateOptions) {
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
      envVars.TRIGGER_SNAPSHOT_POLL_INTERVAL_SECONDS = String(
        this.opts.snapshotPollIntervalSeconds
      );
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

    // Strip image digest — resolve by tag, not digest
    const imageRef = opts.image.split("@")[0]!;

    const url = `${this.opts.gatewayUrl}/api/instances`;

    // Wide event: single canonical log line emitted in finally
    const event: Record<string, unknown> = {
      // High-cardinality identifiers
      runId: opts.runFriendlyId,
      runnerId,
      envId: opts.envId,
      envType: opts.envType,
      orgId: opts.orgId,
      projectId: opts.projectId,
      deploymentVersion: opts.deploymentVersion,
      machine: opts.machine.name,
      // Environment
      instanceName: env.TRIGGER_WORKER_INSTANCE_NAME,
      // Supervisor timing
      dequeueResponseMs: opts.dequeueResponseMs,
      pollingIntervalMs: opts.pollingIntervalMs,
      warmStartCheckMs: opts.warmStartCheckMs,
      // Request
      image: imageRef,
      url,
    };

    const startMs = performance.now();

    try {
      const [fetchError, response] = await tryCatch(
        fetch(url, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(this.opts.gatewayTimeoutMs),
          body: JSON.stringify({
            name: runnerId,
            image: imageRef,
            env: envVars,
            cpu: opts.machine.cpu,
            memory_gb: opts.machine.memory,
            metadata: {
              runId: opts.runFriendlyId,
              envId: opts.envId,
              envType: opts.envType,
              orgId: opts.orgId,
              projectId: opts.projectId,
              deploymentVersion: opts.deploymentVersion,
              machine: opts.machine.name,
            },
          }),
        })
      );

      if (fetchError) {
        event.error = fetchError instanceof Error ? fetchError.message : String(fetchError);
        event.errorType =
          fetchError instanceof DOMException && fetchError.name === "TimeoutError"
            ? "timeout"
            : "fetch";
        return;
      }

      event.status = response.status;

      if (!response.ok) {
        const [bodyError, body] = await tryCatch(response.text());
        event.responseBody = bodyError ? undefined : body;
        return;
      }

      const [parseError, data] = await tryCatch(response.json());

      if (parseError) {
        event.error = parseError instanceof Error ? parseError.message : String(parseError);
        event.errorType = "parse";
        return;
      }

      event.instanceId = data.id;
      event.ok = true;
    } finally {
      event.durationMs = Math.round(performance.now() - startMs);
      event.ok ??= false;
      this.logger.info("create instance", event);
    }
  }

  private get authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.opts.gatewayAuthToken) {
      headers["Authorization"] = `Bearer ${this.opts.gatewayAuthToken}`;
    }
    return headers;
  }

  async snapshot(opts: {
    runnerId: string;
    callbackUrl: string;
    metadata: Record<string, string>;
  }): Promise<boolean> {
    const url = `${this.opts.gatewayUrl}/api/instances/${opts.runnerId}/snapshot`;

    const [error, response] = await tryCatch(
      fetch(url, {
        method: "POST",
        headers: this.authHeaders,
        signal: AbortSignal.timeout(this.opts.gatewayTimeoutMs),
        body: JSON.stringify({
          callback: {
            url: opts.callbackUrl,
            metadata: opts.metadata,
          },
        }),
      })
    );

    if (error) {
      this.logger.error("snapshot request failed", {
        runnerId: opts.runnerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    if (response.status !== 202) {
      this.logger.error("snapshot request rejected", {
        runnerId: opts.runnerId,
        status: response.status,
      });
      return false;
    }

    this.logger.info("snapshot request accepted", { runnerId: opts.runnerId });
    return true;
  }

  async deleteInstance(runnerId: string): Promise<boolean> {
    const url = `${this.opts.gatewayUrl}/api/instances/${runnerId}`;

    const [error, response] = await tryCatch(
      fetch(url, {
        method: "DELETE",
        headers: this.authHeaders,
        signal: AbortSignal.timeout(this.opts.gatewayTimeoutMs),
      })
    );

    if (error) {
      this.logger.error("delete instance failed", {
        runnerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    if (!response.ok) {
      this.logger.error("delete instance rejected", {
        runnerId,
        status: response.status,
      });
      return false;
    }

    this.logger.info("delete instance success", { runnerId });
    return true;
  }

  async restore(snapshotId: string): Promise<boolean> {
    const url = `${this.opts.gatewayUrl}/api/snapshots/${snapshotId}/restore`;

    const [error, response] = await tryCatch(
      fetch(url, {
        method: "POST",
        headers: this.authHeaders,
        signal: AbortSignal.timeout(this.opts.gatewayTimeoutMs),
      })
    );

    if (error) {
      this.logger.error("restore request failed", {
        snapshotId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    if (!response.ok) {
      this.logger.error("restore request rejected", {
        snapshotId,
        status: response.status,
      });
      return false;
    }

    this.logger.info("restore request success", { snapshotId });
    return true;
  }
}
