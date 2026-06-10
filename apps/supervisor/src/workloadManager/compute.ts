import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import { parseTraceparent } from "@trigger.dev/core/v3/isomorphic";
import { flattenAttributes } from "@trigger.dev/core/v3/utils/flattenAttributes";
import {
  type WorkloadManager,
  type WorkloadManagerCreateOptions,
  type WorkloadManagerOptions,
} from "./types.js";
import { ComputeClient, ComputeClientError, stripImageDigest } from "@internal/compute";
import { setTimeout as sleep } from "node:timers/promises";
import { extractTraceparent, getRunnerId } from "../util.js";
import type { OtlpTraceService } from "../services/otlpTraceService.js";
import { tryCatch } from "@trigger.dev/core";
import { encodeBaggage, fromContext } from "../wideEvents/index.js";

const CREATE_MAX_ATTEMPTS = 3;
const CREATE_RETRY_BASE_DELAY_MS = 250;

/**
 * TEMPORARY (TRI-10293): a failed create can leave its instance name
 * registered gateway/fcrun-side until async cleanup runs, so a same-name
 * retry can 409 against our own residue. Until the gateway cleans up
 * failed-create registrations properly, retry attempts get a deterministic
 * suffix. Attempt 1 keeps the unsuffixed name so the non-retry path is
 * unchanged; the suffixed name flows into both the instance name and
 * TRIGGER_RUNNER_ID, which downstream flows treat as one opaque
 * self-reported token. Only attempts following a ComputeClientError are
 * suffixed - network-failure retries keep the same name on purpose, because
 * the gateway's name-collision 409 is their safety net against
 * double-creating an instance whose create response was lost.
 */
export function runnerNameForAttempt(runnerId: string, attempt: number): string {
  return attempt === 1 ? runnerId : `${runnerId}-r${attempt}`;
}

/**
 * Whether a failed instance create is worth retrying. Only statuses where
 * the create definitely did NOT commit are retried: 500 means the agent or
 * fcrun returned a create error (e.g. a netns slot holding the tap busy, a
 * full node disk - placement may differ on retry), 503 means the gateway
 * had nowhere to place it. 502/504 are excluded: the gateway emits those
 * when it fails to reach the node or read its response, which can happen
 * AFTER the agent committed the create - and the gateway only records the
 * instance name on a clean 201, so a same-name retry would miss the
 * collision check and could double-create the VM on another node. 4xx won't
 * heal on retry, and timeouts may still be provisioning. Network-level
 * fetch failures are safe: if the gateway processed the create, its name
 * index is populated and the retry 409s harmlessly.
 */
export function isRetryableCreateError(error: unknown): boolean {
  if (error instanceof ComputeClientError) {
    return error.status === 500 || error.status === 503;
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return false;
  }
  // Network-level fetch failures (gateway briefly unreachable)
  return error instanceof TypeError;
}

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
      // Forward the current wide-event scope's traceparent + request_id so the
      // downstream service continues the same trace and joins its own wide
      // events to ours. Additionally serialize caller-supplied meta labels
      // into the W3C Baggage header so the downstream service auto-stamps
      // them even on early-error paths that bail before parsing the body.
      // When called outside a wide-event scope (or when wide events are
      // disabled), `fromContext` returns undefined and propagation is skipped.
      getPropagationHeaders: () => {
        const state = fromContext();
        if (!state) return {};
        const headers: Record<string, string> = { "x-request-id": state.requestId };
        if (state.traceparent) {
          headers.traceparent = state.traceparent;
        }
        const baggage = encodeBaggage(state.meta);
        if (baggage) {
          headers.baggage = baggage;
        }
        return headers;
      },
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

    // Labels forwarded to the compute provider for network-policy selection;
    // the provider promotes a configured subset to its network layer. Mirrors
    // the privatelink label the Kubernetes workload manager sets on the run pod.
    const labels: Record<string, string> = {};
    if (opts.hasPrivateLink) {
      labels.privatelink = opts.orgId;
    }

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
      const createRequest = {
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
        ...(Object.keys(labels).length > 0 ? { labels } : {}),
      };

      // Retry transient placement failures instead of abandoning the run: a
      // swallowed create error leaves the run waiting for the run engine's
      // PENDING_EXECUTING timeout (minutes) before it is redriven, while a
      // retried create typically succeeds in under a second (TRI-10293).
      let error: unknown;
      let data: Awaited<ReturnType<typeof this.compute.instances.create>> | null | undefined;
      let attempt = 1;
      // Set after a ComputeClientError: the failed create may have left its
      // name registered, so subsequent attempts use a suffixed name.
      let suffixAttempts = false;
      for (; attempt <= CREATE_MAX_ATTEMPTS; attempt++) {
        const attemptRunnerId = suffixAttempts
          ? runnerNameForAttempt(runnerId, attempt)
          : runnerId;
        [error, data] = await tryCatch(
          this.compute.instances.create(
            attemptRunnerId === runnerId
              ? createRequest
              : {
                  ...createRequest,
                  name: attemptRunnerId,
                  env: { ...envVars, TRIGGER_RUNNER_ID: attemptRunnerId },
                }
          )
        );

        if (!error) {
          event.runnerId = attemptRunnerId;
          break;
        }

        if (error instanceof ComputeClientError) {
          suffixAttempts = true;
        }

        this.logger.warn("create instance attempt failed", {
          runnerId: attemptRunnerId,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });

        if (!isRetryableCreateError(error) || attempt === CREATE_MAX_ATTEMPTS) break;
        await sleep(CREATE_RETRY_BASE_DELAY_MS * attempt);
      }
      event.createAttempts = attempt;

      if (error || !data) {
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
    hasPrivateLink?: boolean;
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

    // Resupply the same labels on restore (mirror of the create path); the
    // provider doesn't persist them across a snapshot, so without this a
    // restored run would lose its policy-based network selection.
    const labels: Record<string, string> = {};
    if (opts.hasPrivateLink && opts.orgId) {
      labels.privatelink = opts.orgId;
    }

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
        ...(Object.keys(labels).length > 0 ? { labels } : {}),
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
