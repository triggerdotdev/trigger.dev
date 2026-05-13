/** Documents apps/supervisor/src/workloadManager/compute.ts module purpose and public usage context */
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { parseTraceparent } from "@trigger.dev/core/v3/isomorphic";
import { flattenAttributes } from "@trigger.dev/core/v3/utils/flattenAttributes";
import {
  type WorkloadManager,
  type WorkloadManagerCreateOptions,
  type WorkloadManagerOptions,
} from "./types.js";
import { ComputeClient, stripImageDigest } from "@internal/compute";
import { extractTraceparent, getRunnerId } from "../util.js";
import type { OtlpTraceService } from "../services/otlpTraceService.js";
import { tryCatch } from "@trigger.dev/core";

type ComputeWorkloadManagerOptions = WorkloadManagerOptions & {
  gateway: {
    url: string;
    authToken?: string;
    timeoutMs: number;
  };
  snapshots: {
    enabled: boolean;
    delayMs: number;
    dispatchLimit: number;
    callbackUrl: string;
  };
  tracing?: OtlpTraceService;
  runner: {
    instanceName: string;
    otelEndpoint: string;
    prettyLogs: boolean;
  };
};

export class ComputeWorkloadManager implements WorkloadManager {
  private readonly logger = new SimpleStructuredLogger("compute-workload-manager");
  private readonly compute: ComputeClient;

  constructor(private opts: ComputeWorkloadManagerOptions) {
    if (opts.workloadApiDomain) {
      this.logger.warn("⚠️ Custom workload API domain", {
        domain: opts.workloadApiDomain,
      });
    }

    this.compute = new ComputeClient({
      gatewayUrl: opts.gateway.url,
      authToken: opts.gateway.authToken,
      timeoutMs: opts.gateway.timeoutMs,
    });
  }

  get snapshotsEnabled(): boolean {
    return this.opts.snapshots.enabled;
  }

  get snapshotDelayMs(): number {
    return this.opts.snapshots.delayMs;
  }

  get snapshotDispatchLimit(): number {
    return this.opts.snapshots.dispatchLimit;
  }

  get traceSpansEnabled(): boolean {
    return !!this.opts.tracing;
  }

  async create(opts: WorkloadManagerCreateOptions) {
    const runnerId = getRunnerId(opts.runFriendlyId, opts.nextAttemptNumber);

    const envVars: Record<string, string> = {
      OTEL_EXPORTER_OTLP_ENDPOINT: this.opts.runner.otelEndpoint,
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
      TRIGGER_WORKER_INSTANCE_NAME: this.opts.runner.instanceName,
      TRIGGER_RUNNER_ID: runnerId,
      TRIGGER_MACHINE_CPU: String(opts.machine.cpu),
      TRIGGER_MACHINE_MEMORY: String(opts.machine.memory),
      PRETTY_LOGS: String(this.opts.runner.prettyLogs),
    };

    if (this.opts.warmStartUrl) {
      envVars.TRIGGER_WARM_START_URL = this.opts.warmStartUrl;
    }

    if (this.snapshotsEnabled && this.opts.metadataUrl) {
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

    // Strip image digest - resolve by tag, not digest
    const imageRef = stripImageDigest(opts.image);

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
      instanceName: this.opts.runner.instanceName,
      // Supervisor timing
      dequeueResponseMs: opts.dequeueResponseMs,
      pollingIntervalMs: opts.pollingIntervalMs,
      warmStartCheckMs: opts.warmStartCheckMs,
      // Request
      image: imageRef,
    };

    const startMs = performance.now();

    try {
      const [error, data] = await tryCatch(
        this.compute.instances.create({
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
        })
      );

      if (error) {
        event.error = error instanceof Error ? error.message : String(error);
        event.errorType =
          error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "fetch";
        // Intentional: errors are captured in the wide event, not thrown. This matches
        // the Docker/K8s managers. The run will eventually time out if scheduling fails.
        return;
      }

      event.instanceId = data.id;
      event.ok = true;

      // Parse timing data from compute response (optional - requires gateway timing flag)
      if (data._timing) {
        event.timing = data._timing;
      }

      this.#emitProvisionSpan(opts, startMs, data._timing);
    } finally {
      event.durationMs = Math.round(performance.now() - startMs);
      event.ok ??= false;
      this.logger.debug("create instance", event);
    }
  }

  async snapshot(opts: { runnerId: string; metadata: Record<string, string> }): Promise<boolean> {
    const [error] = await tryCatch(
      this.compute.instances.snapshot(opts.runnerId, {
        callback: {
          url: this.opts.snapshots.callbackUrl,
          metadata: opts.metadata,
        },
      })
    );

    if (error) {
      this.logger.error("snapshot request failed", {
        runnerId: opts.runnerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    this.logger.debug("snapshot request accepted", { runnerId: opts.runnerId });
    return true;
  }

  async deleteInstance(runnerId: string): Promise<boolean> {
    const [error] = await tryCatch(this.compute.instances.delete(runnerId));

    if (error) {
      this.logger.error("delete instance failed", {
        runnerId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    this.logger.debug("delete instance success", { runnerId });
    return true;
  }

  #emitProvisionSpan(opts: WorkloadManagerCreateOptions, startMs: number, timing?: unknown) {
    if (!this.traceSpansEnabled) return;

    const parsed = parseTraceparent(extractTraceparent(opts.traceContext));
    if (!parsed) return;

    const endMs = performance.now();
    const now = Date.now();
    const provisionStartEpochMs = now - (endMs - startMs);
    const endEpochMs = now;

    // Span starts at dequeue time so events (dequeue) render in the thin-line section
    // before "Started". The actual provision call time is in provisionStartEpochMs.
    // Subtract 1ms so compute span always sorts before the attempt span (same dequeue time)
    const startEpochMs = opts.dequeuedAt.getTime() - 1;

    const spanAttributes: Record<string, string | number | boolean> = {
      "compute.type": "create",
      "compute.provision_start_ms": provisionStartEpochMs,
      ...(timing
        ? (flattenAttributes(timing, "compute") as Record<string, string | number | boolean>)
        : {}),
    };

    if (opts.dequeueResponseMs !== undefined) {
      spanAttributes["supervisor.dequeue_response_ms"] = opts.dequeueResponseMs;
    }
    if (opts.warmStartCheckMs !== undefined) {
      spanAttributes["supervisor.warm_start_check_ms"] = opts.warmStartCheckMs;
    }

    // Use the platform API URL, not the runner OTLP endpoint (which may be a VM gateway IP)
    this.opts.tracing?.emit({
      traceId: parsed.traceId,
      parentSpanId: parsed.spanId,
      spanName: "compute.provision",
      startTimeMs: startEpochMs,
      endTimeMs: endEpochMs,
      resourceAttributes: {
        "ctx.environment.id": opts.envId,
        "ctx.organization.id": opts.orgId,
        "ctx.project.id": opts.projectId,
        "ctx.run.id": opts.runFriendlyId,
      },
      spanAttributes,
    });
  }

  async restore(opts: {
    snapshotId: string;
    runnerId: string;
    runFriendlyId: string;
    snapshotFriendlyId: string;
    machine: { cpu: number; memory: number };
    // Trace context for OTel span emission
    traceContext?: Record<string, unknown>;
    envId?: string;
    orgId?: string;
    projectId?: string;
    dequeuedAt?: Date;
  }): Promise<boolean> {
    const metadata: Record<string, string> = {
      TRIGGER_RUNNER_ID: opts.runnerId,
      TRIGGER_RUN_ID: opts.runFriendlyId,
      TRIGGER_SNAPSHOT_ID: opts.snapshotFriendlyId,
      TRIGGER_SUPERVISOR_API_PROTOCOL: this.opts.workloadApiProtocol,
      TRIGGER_SUPERVISOR_API_PORT: String(this.opts.workloadApiPort),
      TRIGGER_SUPERVISOR_API_DOMAIN: this.opts.workloadApiDomain ?? "",
      TRIGGER_WORKER_INSTANCE_NAME: this.opts.runner.instanceName,
    };

    this.logger.verbose("restore request body", {
      snapshotId: opts.snapshotId,
      runnerId: opts.runnerId,
    });

    const startMs = performance.now();

    const [error] = await tryCatch(
      this.compute.snapshots.restore(opts.snapshotId, {
        name: opts.runnerId,
        metadata,
        cpu: opts.machine.cpu,
        memory_gb: opts.machine.memory,
      })
    );

    const durationMs = Math.round(performance.now() - startMs);

    if (error) {
      this.logger.error("restore request failed", {
        snapshotId: opts.snapshotId,
        runnerId: opts.runnerId,
        error: error instanceof Error ? error.message : String(error),
        durationMs,
      });
      return false;
    }

    this.logger.debug("restore request success", {
      snapshotId: opts.snapshotId,
      runnerId: opts.runnerId,
      durationMs,
    });

    this.#emitRestoreSpan(opts, startMs);

    return true;
  }

  #emitRestoreSpan(
    opts: {
      snapshotId: string;
      runnerId: string;
      runFriendlyId: string;
      traceContext?: Record<string, unknown>;
      envId?: string;
      orgId?: string;
      projectId?: string;
      dequeuedAt?: Date;
    },
    startMs: number
  ) {
    if (!this.traceSpansEnabled) return;

    const parsed = parseTraceparent(extractTraceparent(opts.traceContext));
    if (!parsed || !opts.envId || !opts.orgId || !opts.projectId) return;

    const endMs = performance.now();
    const now = Date.now();
    const restoreStartEpochMs = now - (endMs - startMs);
    const endEpochMs = now;

    // Subtract 1ms so restore span always sorts before the attempt span
    const startEpochMs = (opts.dequeuedAt?.getTime() ?? restoreStartEpochMs) - 1;

    this.opts.tracing?.emit({
      traceId: parsed.traceId,
      parentSpanId: parsed.spanId,
      spanName: "compute.restore",
      startTimeMs: startEpochMs,
      endTimeMs: endEpochMs,
      resourceAttributes: {
        "ctx.environment.id": opts.envId,
        "ctx.organization.id": opts.orgId,
        "ctx.project.id": opts.projectId,
        "ctx.run.id": opts.runFriendlyId,
      },
      spanAttributes: {
        "compute.type": "restore",
        "compute.snapshot_id": opts.snapshotId,
      },
    });
  }
}
