import { type CheckpointClient, HttpServer } from "@trigger.dev/core/v3/serverOnly";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import {
  type WorkloadRunSnapshotsSinceResponseBody,
  type SupervisorHttpClient,
  WORKLOAD_HEADERS,
  type WorkloadClientSocketData,
  type WorkloadClientToServerEvents,
  type WorkloadContinueRunExecutionResponseBody,
  WorkloadDebugLogRequestBody,
  WorkloadHeartbeatRequestBody,
  type WorkloadHeartbeatResponseBody,
  WorkloadRunAttemptCompleteRequestBody,
  type WorkloadRunAttemptCompleteResponseBody,
  WorkloadRunAttemptStartRequestBody,
  type WorkloadRunAttemptStartResponseBody,
  type WorkloadServerToClientEvents,
  type WorkloadSuspendRunResponseBody,
} from "@trigger.dev/core/v3/workers";
import EventEmitter from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type Namespace, Server, type Socket } from "socket.io";
import { z } from "zod";
import { tryCatch } from "@trigger.dev/core/utils";
import { Counter, Histogram } from "prom-client";
import { env } from "../env.js";
import { register } from "../metrics.js";
import {
  checkPreviousKeyRunCutoff,
  previousKeyCutoffEnforced,
  previousKeyCutoffMode,
  verifyDeploymentIdHeader,
  type WorkloadAuthTransport,
  type WorkloadTokenKey,
  workloadTokenEnforced,
  workloadTokensEnabled,
} from "../workloadToken.js";
import type { WorkloadDeploymentTokenClaims } from "@trigger.dev/core/v3";
import {
  SecretProxyAllocationBusyError,
  SecretProxyPlacementPendingError,
  SecretProxyPlacementSaturatedError,
  type SecretProxyBindings,
  type SecretProxyCaller,
  type SecretProxyPlacement,
} from "../services/secretProxyBindings.js";
import {
  ComputeSnapshotService,
  type RunnerSnapshotter,
} from "../services/computeSnapshotService.js";
import {
  emitOneShot,
  runWideEvent,
  setMeta,
  type State,
  type WideEventOptions,
} from "../wideEvents/index.js";

// Use the official export when upgrading to socket.io@4.8.0
interface DefaultEventsMap {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [event: string]: (...args: any[]) => void;
}

const SECRET_PROXY_ATTACH_RETRY_DELAY_MS = 1_000;
// A guest can call start or continue before kubelet publishes its Pod status.
const SECRET_PROXY_PLACEMENT_WAIT_MS = 5_000;
const SECRET_PROXY_PLACEMENT_RETRY_MS = 250;

const secretProxyPlacementWait = new Histogram({
  name: "supervisor_secret_proxy_placement_wait_seconds",
  help: "Time spent waiting for placement after an incomplete Pod status lookup",
  labelNames: ["route", "outcome"],
  buckets: [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8],
  registers: [register],
});

const unplacedSecretProxyContinues = new Counter({
  name: "supervisor_secret_proxy_unplaced_continues_total",
  help: "Continues forwarded without proxy capability on a proxy-configured supervisor",
  registers: [register],
});

const unsupportedSecretProxyStarts = new Counter({
  name: "supervisor_secret_proxy_unsupported_starts_total",
  help: "Starts without proxy capability on a proxy-configured supervisor",
  labelNames: ["reason"],
  registers: [register],
});

const checkpointDeleteRequests = new Counter({
  name: "checkpoint_delete_requests_total",
  help: "Checkpoint delete requests attempted at run completion, by outcome",
  labelNames: ["result"],
  registers: [register],
});

const snapshotDeleteRequests = new Counter({
  name: "snapshot_delete_requests_total",
  help: "Suspend snapshot delete requests attempted at run completion on the microVM lane, by outcome: sent (first try), retried (accepted after retries), gave_up (service down for the whole retry budget), http_error (refused)",
  labelNames: ["result"],
  registers: [register],
});

const continueRetryOutcomes = new Counter({
  name: "supervisor_continue_retry_outcomes_total",
  help: "Count of continue calls retried within a budget, by how the retries ended (succeeded, non_retryable, server_errors, budget_exhausted).",
  labelNames: ["outcome"],
  registers: [register],
});

const checkpointCancelRequests = new Counter({
  name: "checkpoint_cancel_requests_total",
  help: "Checkpoint cancel requests attempted when a run continues, by outcome",
  labelNames: ["result"],
  registers: [register],
});

// Alphanumeric bodies cover nanoid, cuid, run-ops, and legacy base62 IDs.
const WorkloadRunFriendlyId = z.string().regex(/^run_[a-zA-Z0-9]+$/);
const WorkloadActionParams = z.compile(
  z.object({
    runFriendlyId: WorkloadRunFriendlyId,
    snapshotFriendlyId: z.string().regex(/^snapshot_[a-zA-Z0-9]+$/),
  })
);
const WorkloadDebugParams = z.compile(WorkloadActionParams.pick({ runFriendlyId: true }));
const CompiledWorkloadRunAttemptStartRequestBody = z.compile(WorkloadRunAttemptStartRequestBody);
const CompiledWorkloadHeartbeatRequestBody = z.compile(WorkloadHeartbeatRequestBody);
const CompiledWorkloadDebugLogRequestBody = z.compile(WorkloadDebugLogRequestBody);

// Workloads bundled into customer task images before CLI v4.4.4 use a strict
// zod enum for checkpoint type that only allows DOCKER and KUBERNETES. The
// workload never reads this field - it only validates the response shape - so
// rewriting it to a known value keeps older runners working without affecting
// the value stored in the database or seen by internal services.
function legacifyCheckpointType<T extends { checkpoint?: { type: string } | null }>(item: T): T {
  if (item.checkpoint?.type === "COMPUTE") {
    return { ...item, checkpoint: { ...item.checkpoint, type: "KUBERNETES" } } as T;
  }
  return item;
}

type SupervisorSocketData = WorkloadClientSocketData & {
  workloadTokenKey?: WorkloadTokenKey;
  workloadTokenRunCutoffMs?: number;
  workloadTokenClaims?: WorkloadDeploymentTokenClaims;
};

type PreviousKeyCaller = {
  transport: WorkloadAuthTransport;
  remoteAddress?: string;
  remotePort?: number;
  runnerId?: string;
  userAgent?: string;
  route: string;
  claims?: WorkloadDeploymentTokenClaims;
  runCutoffMs?: number;
};

// A verified sandbox token is run-scoped even in log mode.
function sandboxRunAllowed(
  runFriendlyId: string,
  claims: WorkloadDeploymentTokenClaims | undefined
): boolean {
  return claims?.execution_mode !== "SANDBOX" || claims.run === runFriendlyId;
}

function runFriendlyIdFromMessage(message: unknown): string {
  const friendlyId = (message as { run?: { friendlyId?: unknown } } | undefined)?.run?.friendlyId;
  return WorkloadRunFriendlyId.parse(friendlyId);
}

type WorkloadServerEvents = {
  runConnected: [
    {
      run: {
        friendlyId: string;
      };
    },
  ];
  runDisconnected: [
    {
      run: {
        friendlyId: string;
      };
    },
  ];
};

type WorkloadServerOptions = {
  port: number;
  host?: string;
  workerClient: SupervisorHttpClient;
  checkpointClient?: CheckpointClient;
  /** Takes the microVM lane's snapshot deletes, which have no checkpoint service beside them. */
  snapshotDeleteClient?: CheckpointClient;
  /** The run-crd backend, which asks the operator for a suspend on the Runner. */
  runnerSnapshotter?: RunnerSnapshotter & { snapshotsEnabled: boolean };
  wideEventOpts: WideEventOptions;
  /** When true, high-frequency HTTP routes also emit wide events. */
  wideEventsNoisyRoutes: boolean;
  /** Where runs started through this server execute. Overrides anything the runner sends. */
  workerStamp?: { workerCell?: string; workerLane?: string };
  /** How long to keep retrying temporary failures of `continue`. Unset keeps the default retries. */
  continueRetryBudgetMs?: number;
  secretProxy?: SecretProxyBindings;
  retireRunner?: (runnerId: string, uid: string) => Promise<void>;
};

export class WorkloadServer extends EventEmitter<WorkloadServerEvents> {
  private checkpointClient?: CheckpointClient;
  private readonly snapshotDeleteClient?: CheckpointClient;
  private readonly snapshotService?: ComputeSnapshotService;

  private readonly logger = new SimpleStructuredLogger("workload-server");
  private readonly wideEventOpts: WideEventOptions;
  private readonly wideEventsNoisyRoutes: boolean;

  private readonly httpServer: HttpServer;
  private readonly websocketServer: Namespace<
    WorkloadClientToServerEvents,
    WorkloadServerToClientEvents,
    DefaultEventsMap,
    SupervisorSocketData
  >;

  private readonly runSockets = new Map<
    string,
    Socket<
      WorkloadClientToServerEvents,
      WorkloadServerToClientEvents,
      DefaultEventsMap,
      SupervisorSocketData
    >
  >();

  private readonly workerClient: SupervisorHttpClient;
  private readonly workerStamp: { workerCell?: string; workerLane?: string };
  private readonly continueRetryBudget?: { budgetMs: number };
  private readonly secretProxy?: SecretProxyBindings;
  private readonly retireRunner?: WorkloadServerOptions["retireRunner"];

  constructor(opts: WorkloadServerOptions) {
    super();

    const host = opts.host ?? "0.0.0.0";
    const port = opts.port;

    this.workerClient = opts.workerClient;
    this.secretProxy = opts.secretProxy;
    this.retireRunner = opts.retireRunner;
    this.workerStamp = opts.workerStamp ?? {};
    this.checkpointClient = opts.checkpointClient;
    this.snapshotDeleteClient = opts.snapshotDeleteClient;
    this.wideEventOpts = opts.wideEventOpts;
    this.wideEventsNoisyRoutes = opts.wideEventsNoisyRoutes;

    this.continueRetryBudget =
      opts.continueRetryBudgetMs === undefined
        ? undefined
        : { budgetMs: opts.continueRetryBudgetMs };
    this.logger.info("Continue retries", {
      budgetMs: opts.continueRetryBudgetMs ?? "unset, default retries",
    });

    if (opts.runnerSnapshotter?.snapshotsEnabled) {
      const secretProxy = opts.secretProxy;
      this.snapshotService = new ComputeSnapshotService({
        runnerSnapshotter: opts.runnerSnapshotter,
        workerClient: opts.workerClient,
        wideEventOpts: this.wideEventOpts,
        beforeSuspend: secretProxy
          ? (runFriendlyId, snapshotFriendlyId) =>
              secretProxy.revokeSuspending(runFriendlyId, snapshotFriendlyId)
          : undefined,
        suspendSettled: secretProxy
          ? (runFriendlyId, snapshotFriendlyId, accepted) =>
              secretProxy.suspendSettled(runFriendlyId, snapshotFriendlyId, accepted)
          : undefined,
      });
    }

    this.httpServer = this.createHttpServer({ host, port });
    this.websocketServer = this.createWebsocketServer();
  }

  private headerValueFromRequest(req: IncomingMessage, headerName: string): string | undefined {
    const value = req.headers[headerName];

    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  private runnerIdFromRequest(req: IncomingMessage): string | undefined {
    return this.headerValueFromRequest(req, WORKLOAD_HEADERS.RUNNER_ID);
  }

  private deploymentIdFromRequest(req: IncomingMessage): string | undefined {
    return this.headerValueFromRequest(req, WORKLOAD_HEADERS.DEPLOYMENT_ID);
  }

  private deploymentVersionFromRequest(req: IncomingMessage): string | undefined {
    return this.headerValueFromRequest(req, WORKLOAD_HEADERS.DEPLOYMENT_VERSION);
  }

  private projectRefFromRequest(req: IncomingMessage): string | undefined {
    return this.headerValueFromRequest(req, WORKLOAD_HEADERS.PROJECT_REF);
  }

  /**
   * Verify the deployment token from the workload deployment-id header and return the verified
   * environment_id to forward upstream. The env id is only forwarded in enforce mode: in log mode
   * we still verify + record metrics but attach no header (so the platform never scopes). Only
   * enforce rejects invalid tokens; absent and legacy ids pass. Verified sandbox tokens are
   * always restricted to their own run, including in log mode.
   *
   * `claims` are returned on any valid token, for local use only - never to scope the platform,
   * which is why environmentId stays gated on enforce.
   */
  private async authorizeWorkloadRequest(
    req: IncomingMessage,
    runFriendlyId: string,
    completing = false
  ): Promise<
    | {
        ok: true;
        environmentId?: string;
        sandboxRunId?: string;
        claims?: WorkloadDeploymentTokenClaims;
      }
    | { ok: false }
  > {
    if (!workloadTokensEnabled) {
      return this.secretProxy ? { ok: false } : { ok: true };
    }

    const result = await verifyDeploymentIdHeader(this.deploymentIdFromRequest(req), "http");

    if (result.outcome === "jwt_invalid" && workloadTokenEnforced) {
      return { ok: false };
    }

    if (!sandboxRunAllowed(runFriendlyId, result.claims)) {
      return { ok: false };
    }

    if (
      result.key === "previous" &&
      !this.previousKeyRunAllowed(runFriendlyId, {
        transport: "http",
        remoteAddress: req.socket.remoteAddress,
        remotePort: req.socket.remotePort,
        runnerId: this.runnerIdFromRequest(req),
        userAgent: this.headerValueFromRequest(req, "user-agent"),
        route: `${req.method} ${req.url}`,
        claims: result.claims,
        runCutoffMs: result.runCutoffMs,
      })
    ) {
      return { ok: false };
    }

    const isStart = req.url?.split("?")[0]?.endsWith("/attempts/start") === true;
    if (!isStart && this.secretProxy?.tracks(runFriendlyId)) {
      try {
        await this.secretProxy.authorize(
          {
            runId: runFriendlyId,
            runnerId: this.runnerIdFromRequest(req),
            sourceIp: req.socket.remoteAddress,
            claims: result.outcome === "jwt_valid" ? result.claims : undefined,
          },
          completing
        );
      } catch {
        return { ok: false };
      }
    }

    const verified =
      workloadTokenEnforced && result.outcome === "jwt_valid" ? result.claims : undefined;
    return {
      ok: true,
      environmentId: verified?.environment_id,
      sandboxRunId: verified?.execution_mode === "SANDBOX" ? verified.run : undefined,
      claims: result.outcome === "jwt_valid" ? result.claims : undefined,
    };
  }

  private previousKeyRunAllowed(runFriendlyId: string, caller: PreviousKeyCaller): boolean {
    const { claims, runCutoffMs, ...callerFields } = caller;
    const cutoff = checkPreviousKeyRunCutoff(runFriendlyId, runCutoffMs);
    const logArgs = {
      runId: runFriendlyId,
      key: "previous",
      cutoffResult: cutoff,
      cutoffMode: previousKeyCutoffMode,
      ...callerFields,
      deployment: claims?.deployment,
      environmentId: claims?.environment_id,
      orgId: claims?.org_id,
      projectId: claims?.project_id,
      exp: claims?.exp,
    };

    if (cutoff === "pass") {
      this.logger.debug("Previous-key token accepted", logArgs);
      return true;
    }

    this.logger.warn("Previous-key token used for a run created after the cutoff", logArgs);
    return !(workloadTokenEnforced && previousKeyCutoffEnforced);
  }

  /**
   * reclaimCheckpoints asks the checkpoint service to delete a finished run's checkpoint storage.
   * Must be called after the reply is sent: it never delays the runner.
   */
  private async reclaimCheckpoints(
    req: IncomingMessage,
    runFriendlyId: string,
    attemptStatus: string,
    claims: WorkloadDeploymentTokenClaims | undefined
  ): Promise<void> {
    if (this.snapshotService) {
      checkpointDeleteRequests.inc({ result: "not_applicable" });
      // Not awaited: its retries can run for minutes, and nothing here waits on them.
      void this.reclaimSnapshots(runFriendlyId, attemptStatus, claims);
      return;
    }

    if (!env.DELETE_CHECKPOINTS_ON_COMPLETION) {
      checkpointDeleteRequests.inc({ result: "disabled" });
      return;
    }

    if (!this.checkpointClient) {
      checkpointDeleteRequests.inc({ result: "no_client" });
      return;
    }

    if (attemptStatus !== "RUN_FINISHED" && attemptStatus !== "RUN_PENDING_CANCEL") {
      checkpointDeleteRequests.inc({ result: "not_terminal" });
      return;
    }

    if (!claims) {
      checkpointDeleteRequests.inc({ result: "no_claims" });
      return;
    }

    const projectRef = this.projectRefFromRequest(req);
    if (!projectRef) {
      checkpointDeleteRequests.inc({ result: "no_project_ref" });
      this.logger.error("Cannot reclaim checkpoints without a project ref", { runFriendlyId });
      return;
    }

    const [error, accepted] = await tryCatch(
      this.checkpointClient.deleteCheckpoints({
        runFriendlyId,
        body: {
          orgId: claims.org_id,
          envId: claims.environment_id,
          deploymentVersion: claims.deployment_version,
          projectRef,
        },
      })
    );

    if (error || !accepted) {
      checkpointDeleteRequests.inc({ result: "http_error" });
      this.logger.error("Failed to request checkpoint reclaim", { runFriendlyId, error });
      return;
    }

    checkpointDeleteRequests.inc({ result: "sent" });
  }

  /**
   * reclaimSnapshots is the microVM lane's reclaim: it asks for every suspend snapshot of the run to
   * be deleted from the shared store, keyed by the project's ID as the snapshots are labelled.
   */
  private async reclaimSnapshots(
    runFriendlyId: string,
    attemptStatus: string,
    claims: WorkloadDeploymentTokenClaims | undefined
  ): Promise<void> {
    if (!env.DELETE_SNAPSHOTS_ON_COMPLETION) {
      snapshotDeleteRequests.inc({ result: "disabled" });
      return;
    }

    if (!this.snapshotDeleteClient) {
      snapshotDeleteRequests.inc({ result: "no_client" });
      return;
    }

    if (attemptStatus !== "RUN_FINISHED" && attemptStatus !== "RUN_PENDING_CANCEL") {
      snapshotDeleteRequests.inc({ result: "not_terminal" });
      return;
    }

    if (!claims) {
      snapshotDeleteRequests.inc({ result: "no_claims" });
      return;
    }

    const [error, result] = await tryCatch(
      this.snapshotDeleteClient.deleteSnapshots({
        runFriendlyId,
        body: {
          orgId: claims.org_id,
          envId: claims.environment_id,
          projectId: claims.project_id,
          deploymentVersion: claims.deployment_version,
        },
      })
    );

    if (error) {
      snapshotDeleteRequests.inc({ result: "http_error" });
      this.logger.error("Failed to request snapshot reclaim", { runFriendlyId, error });
      return;
    }

    switch (result.outcome) {
      case "accepted":
        snapshotDeleteRequests.inc({ result: result.attempts > 1 ? "retried" : "sent" });
        return;
      case "rejected":
        snapshotDeleteRequests.inc({ result: "http_error" });
        return;
      case "gave_up":
        snapshotDeleteRequests.inc({ result: "gave_up" });
        this.logger.error("Gave up requesting snapshot reclaim", {
          runFriendlyId,
          attempts: result.attempts,
          status: result.status,
        });
        return;
    }
  }

  private async cancelCheckpointsAfterReply(runFriendlyId: string): Promise<void> {
    if (!this.checkpointClient) {
      checkpointCancelRequests.inc({ result: "no_client" });
      return;
    }

    if (this.snapshotService) {
      checkpointCancelRequests.inc({ result: "not_applicable" });
      return;
    }

    const [error, accepted] = await tryCatch(
      this.checkpointClient.cancelCheckpoints({ runFriendlyId })
    );

    if (error || !accepted) {
      checkpointCancelRequests.inc({ result: "http_error" });
      this.logger.error("Failed to request checkpoint cancel", { runFriendlyId, error });
      return;
    }

    checkpointCancelRequests.inc({ result: "sent" });
  }

  /**
   * Sets common route meta on the wide-event state from URL params.
   */
  private attachRouteMeta(state: State, params: unknown): void {
    if (!params || typeof params !== "object") return;
    const p = params as Record<string, unknown>;
    if (typeof p.runFriendlyId === "string") setMeta(state, "run_id", p.runFriendlyId);
    if (typeof p.snapshotFriendlyId === "string") {
      setMeta(state, "snapshot_id", p.snapshotFriendlyId);
    }
    if (typeof p.deploymentId === "string") setMeta(state, "deployment_id", p.deploymentId);
  }

  /**
   * Wraps an HTTP route handler body with the wide-event lifecycle. Reads
   * `traceparent` and `x-request-id` from `req.headers`, attaches `run_id` /
   * `snapshot_id` / `deployment_id` meta from `params` when present, and
   * captures the response status from `res.statusCode` after `fn` returns.
   *
   * Pass `highFrequency: true` for noisy routes (heartbeat, polling). Those
   * still go through the wrapper but only emit when
   * `TRIGGER_WIDE_EVENTS_NOISY_ROUTES` is on, so prod can keep them dark
   * while test envs capture full-fidelity traffic for debugging.
   */
  private wideRoute<T>(
    ctx: { req: IncomingMessage; res: ServerResponse; params?: unknown },
    op: string,
    route: string,
    method: string,
    fn: () => Promise<T> | T,
    routeOpts: { highFrequency?: boolean } = {}
  ): Promise<T> {
    const enabled =
      this.wideEventOpts.enabled && (!routeOpts.highFrequency || this.wideEventsNoisyRoutes);
    return runWideEvent(
      {
        ...this.wideEventOpts,
        enabled,
        op,
        kind: "inbound",
        route,
        method,
        traceparent: this.headerValueFromRequest(ctx.req, "traceparent"),
        inboundRequestId: this.headerValueFromRequest(ctx.req, "x-request-id"),
        setup: (state) => this.attachRouteMeta(state, ctx.params),
      },
      fn,
      (state) => {
        state.statusCode = ctx.res.statusCode;
      }
    );
  }

  private withSecretProxy<T>(
    runId: string,
    runnerId: string | undefined,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.secretProxy ? this.secretProxy.exclusive(runId, operation, runnerId) : operation();
  }

  private createHttpServer({ host, port }: { host: string; port: number }) {
    const httpServer = new HttpServer({
      port,
      host,
      bodySizeLimitMode: env.TRIGGER_WORKLOAD_API_BODY_SIZE_LIMIT_MODE,
      metrics: {
        register,
        expose: false,
      },
    })
      .route("/health", "GET", {
        handler: async ({ reply }) => {
          reply.text("OK");
        },
      })
      .route(
        "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/attempts/start",
        "POST",
        {
          paramsSchema: WorkloadActionParams,
          bodySchema: CompiledWorkloadRunAttemptStartRequestBody,
          handler: async (ctx) =>
            this.wideRoute(
              ctx,
              "attempt.start",
              "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/attempts/start",
              "POST",
              async () => {
                const { req, reply, params, body } = ctx;
                const auth = await this.authorizeWorkloadRequest(req, params.runFriendlyId);
                if (!auth.ok) {
                  reply.empty(401);
                  return;
                }
                const caller = {
                  runId: params.runFriendlyId,
                  runnerId: this.runnerIdFromRequest(req),
                  sourceIp: req.socket.remoteAddress,
                  claims: auth.claims,
                };
                try {
                  const placement = await this.waitForSecretProxyPlacement(caller);
                  const supportsSecretProxy = !!placement;
                  if (this.secretProxy && !supportsSecretProxy) {
                    unsupportedSecretProxyStarts.inc({ reason: "unavailable" });
                  }
                  let attachmentFailed = false;
                  const start = async () => {
                    let startResponse = await this.workerClient.startRunAttempt(
                      params.runFriendlyId,
                      params.snapshotFriendlyId,
                      {
                        ...body,
                        isWarmStart: placement?.isWarmStart ?? body.isWarmStart,
                        supportsSecretProxy,
                        workerCell: this.workerStamp.workerCell,
                        workerLane: this.workerStamp.workerLane,
                      },
                      caller.runnerId,
                      auth.environmentId,
                      auth.sandboxRunId
                    );
                    if (startResponse.success && (placement || startResponse.data.secretProxy)) {
                      const response = startResponse;
                      try {
                        if (!placement || !this.secretProxy)
                          throw new Error("Secret proxy unavailable");
                        await this.secretProxy.activateStart(caller, placement, response.data);
                      } catch {
                        const complete = () =>
                          this.workerClient.completeRunAttempt(
                            params.runFriendlyId,
                            response.data.snapshot.friendlyId,
                            {
                              attemptNumber: response.data.execution.attempt.number,
                              completion: {
                                ok: false,
                                id: params.runFriendlyId,
                                error: {
                                  type: "INTERNAL_ERROR",
                                  code: "TASK_EXECUTION_ABORTED",
                                  message: "Secret proxy attachment failed",
                                },
                                retry: {
                                  delay: SECRET_PROXY_ATTACH_RETRY_DELAY_MS,
                                  timestamp: Date.now() + SECRET_PROXY_ATTACH_RETRY_DELAY_MS,
                                },
                              },
                              forceRequeue: true,
                            },
                            caller.runnerId,
                            auth.environmentId
                          );
                        if (this.secretProxy && placement) {
                          await this.secretProxy.failStart(caller, placement.bindingId, complete);
                        } else {
                          await complete();
                        }

                        attachmentFailed = true;
                        startResponse = {
                          success: false,
                          error: "Secret proxy unavailable",
                          statusCode: 503,
                        };
                      }
                    }

                    return startResponse;
                  };
                  const startResponse =
                    placement && this.secretProxy
                      ? await this.secretProxy.withStart(placement, start)
                      : await start();
                  if (attachmentFailed && placement)
                    await this.secretProxy?.retryFailedStart(placement.bindingId);

                  if (!startResponse.success) {
                    this.logger.error("Failed to start run", {
                      params,
                      error: startResponse.error,
                    });
                    reply.empty(500);
                    return;
                  }

                  reply.json(startResponse.data satisfies WorkloadRunAttemptStartResponseBody);
                  return;
                } catch (error) {
                  if (error instanceof SecretProxyAllocationBusyError) {
                    ctx.res.setHeader("x-should-retry", "false");
                    const { runnerId, runnerUid } = error.runner;
                    try {
                      await this.revokeRunner(runnerId, runnerUid, error.discovered);
                    } catch (revokeError) {
                      this.logger.error("Failed to revoke retiring runner", {
                        runnerId,
                        revokeError,
                      });
                    }
                    try {
                      if (!this.retireRunner) throw new Error("Runner retirement unavailable");
                      await this.retireRunner(runnerId, runnerUid);
                    } catch (retireError) {
                      this.logger.error("Failed to retire busy runner", { runnerId, retireError });
                    }
                    reply.json(
                      { error: "Runner retired after busy allocation", code: "RUNNER_RETIRED" },
                      false,
                      410
                    );
                    return;
                  }
                  throw error;
                }
              }
            ),
        }
      )
      .route(
        "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/attempts/complete",
        "POST",
        {
          paramsSchema: WorkloadActionParams,
          bodySchema: WorkloadRunAttemptCompleteRequestBody,
          maxBodySize: env.TRIGGER_WORKLOAD_API_COMPLETE_MAX_BODY_SIZE,
          handler: async (ctx) =>
            this.wideRoute(
              ctx,
              "attempt.complete",
              "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/attempts/complete",
              "POST",
              async () => {
                const { req, reply, params, body } = ctx;
                const auth = await this.authorizeWorkloadRequest(req, params.runFriendlyId, true);
                if (!auth.ok) {
                  reply.empty(401);
                  return;
                }
                const runnerId = this.runnerIdFromRequest(req);

                // Any completion attempt makes a pending snapshot stale. Cancel before the
                // await, or the timer wheel can dispatch it and pause a VM that has moved on.
                // The runnerId guard stops a stale duplicate cancelling a fresh runner's
                // snapshot, and no new suspend can be scheduled before this route replies.
                this.snapshotService?.cancel(params.runFriendlyId, runnerId);

                const { attemptNumber, ...completion } = body;
                const complete = () =>
                  this.workerClient.completeRunAttempt(
                    params.runFriendlyId,
                    params.snapshotFriendlyId,
                    this.secretProxy ? body : completion,
                    runnerId,
                    auth.environmentId
                  );
                const completeResponse = this.secretProxy
                  ? await this.secretProxy.complete(
                      {
                        runId: params.runFriendlyId,
                        runnerId,
                        sourceIp: req.socket.remoteAddress,
                        claims: auth.claims,
                      },
                      complete,
                      attemptNumber
                    )
                  : await complete();

                if (!completeResponse.success) {
                  this.logger.error("Failed to complete run", {
                    params,
                    error: completeResponse.error,
                  });
                  reply.empty(500);
                  return;
                }

                reply.json(completeResponse.data satisfies WorkloadRunAttemptCompleteResponseBody);

                await this.reclaimCheckpoints(
                  req,
                  params.runFriendlyId,
                  completeResponse.data.result.attemptStatus,
                  auth.claims
                );
                return;
              }
            ),
        }
      )
      .route(
        "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/heartbeat",
        "POST",
        {
          paramsSchema: WorkloadActionParams,
          bodySchema: CompiledWorkloadHeartbeatRequestBody,
          handler: async (ctx) =>
            this.wideRoute(
              ctx,
              "heartbeat",
              "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/heartbeat",
              "POST",
              async () => {
                const { req, reply, params, body } = ctx;
                const auth = await this.authorizeWorkloadRequest(req, params.runFriendlyId);
                if (!auth.ok) {
                  reply.empty(401);
                  return;
                }
                const heartbeatResponse = await this.withSecretProxy(
                  params.runFriendlyId,
                  this.runnerIdFromRequest(req),
                  async () => {
                    const response = await this.workerClient.heartbeatRun(
                      params.runFriendlyId,
                      params.snapshotFriendlyId,
                      body,
                      this.runnerIdFromRequest(req),
                      auth.environmentId,
                      auth.sandboxRunId
                    );
                    if (response.success) {
                      await this.secretProxy?.refresh(params.runFriendlyId, response.data.runToken);
                    }
                    return response;
                  }
                );
                // An execution that lost its binding mid-attempt is bound again by its own VM.
                if (heartbeatResponse.success) {
                  await this.secretProxy?.rebindContinued(
                    {
                      runId: params.runFriendlyId,
                      runnerId: this.runnerIdFromRequest(req),
                      sourceIp: req.socket.remoteAddress,
                      claims: auth.claims,
                    },
                    heartbeatResponse.data.runToken
                  );
                }

                if (!heartbeatResponse.success) {
                  this.logger.error("Failed to heartbeat run", {
                    params,
                    error: heartbeatResponse.error,
                  });
                  reply.empty(500);
                  return;
                }

                // Carries any replacement run token through to the runner. Never log this body.
                reply.json(heartbeatResponse.data satisfies WorkloadHeartbeatResponseBody);
              },
              { highFrequency: true }
            ),
        }
      )
      .route(
        "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/suspend",
        "GET",
        {
          paramsSchema: WorkloadActionParams,
          handler: async (ctx) =>
            this.wideRoute(
              ctx,
              "suspend",
              "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/suspend",
              "GET",
              async () => {
                const { reply, params, req } = ctx;
                const auth = await this.authorizeWorkloadRequest(req, params.runFriendlyId);
                if (!auth.ok) {
                  reply.empty(401);
                  return;
                }
                const runnerId = this.runnerIdFromRequest(req);
                const deploymentVersion = this.deploymentVersionFromRequest(req);
                const projectRef = this.projectRefFromRequest(req);

                this.logger.debug("Suspend request", {
                  params,
                  runnerId,
                  deploymentVersion,
                  projectRef,
                });

                if (!runnerId || !deploymentVersion || !projectRef) {
                  this.logger.error("Invalid headers for suspend request", {
                    ...params,
                    runnerId,
                    deploymentVersion,
                    projectRef,
                  });
                  reply.json(
                    {
                      ok: false,
                      error: "Invalid headers",
                    } satisfies WorkloadSuspendRunResponseBody,
                    false,
                    400
                  );
                  return;
                }

                if (this.snapshotService) {
                  // Delayed so a short-lived waitpoint that continues first cancels the snapshot.
                  reply.json({ ok: true } satisfies WorkloadSuspendRunResponseBody, false, 202);

                  this.snapshotService.schedule(params.runFriendlyId, {
                    runnerId,
                    runFriendlyId: params.runFriendlyId,
                    snapshotFriendlyId: params.snapshotFriendlyId,
                    environmentId: auth.environmentId,
                    owner: auth.claims && {
                      envId: auth.claims.environment_id,
                      deploymentFriendlyId: auth.claims.deployment,
                    },
                  });

                  return;
                }

                if (!this.checkpointClient) {
                  reply.json(
                    {
                      ok: false,
                      error: "Checkpoints disabled",
                    } satisfies WorkloadSuspendRunResponseBody,
                    false,
                    400
                  );
                  return;
                }

                reply.json(
                  {
                    ok: true,
                  } satisfies WorkloadSuspendRunResponseBody,
                  false,
                  202
                );

                const suspendResult = await this.checkpointClient.suspendRun({
                  runFriendlyId: params.runFriendlyId,
                  snapshotFriendlyId: params.snapshotFriendlyId,
                  body: {
                    runnerId,
                    runId: params.runFriendlyId,
                    snapshotId: params.snapshotFriendlyId,
                    projectRef,
                    deploymentVersion,
                    environmentId: auth.environmentId,
                  },
                });

                if (!suspendResult) {
                  this.logger.error("Failed to suspend run", { params });
                  return;
                }
              }
            ),
        }
      )
      .route(
        "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/continue",
        "GET",
        {
          paramsSchema: WorkloadActionParams,
          handler: async (ctx) =>
            this.wideRoute(
              ctx,
              "continue",
              "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/continue",
              "GET",
              async () => {
                const { req, reply, params } = ctx;
                const auth = await this.authorizeWorkloadRequest(req, params.runFriendlyId);
                if (!auth.ok) {
                  reply.empty(401);
                  return;
                }
                this.logger.debug("Run continuation request", { params });

                // Cancel any pending delayed snapshot for this run
                this.snapshotService?.cancel(params.runFriendlyId);

                const caller = {
                  runId: params.runFriendlyId,
                  runnerId: this.runnerIdFromRequest(req),
                  sourceIp: req.socket.remoteAddress,
                  claims: auth.claims,
                };
                const placement = this.secretProxy?.tracks(params.runFriendlyId)
                  ? undefined
                  : await this.waitForSecretProxyPlacement(caller, { continuing: true });
                const continuationResult = await this.workerClient.continueRunExecution(
                  params.runFriendlyId,
                  params.snapshotFriendlyId,
                  caller.runnerId,
                  auth.environmentId,
                  {
                    retryBudget: this.continueRetryBudget,
                    supportsSecretProxy: !!placement,
                    sandboxRunId: auth.sandboxRunId,
                  }
                );

                if (continuationResult.retry) {
                  continueRetryOutcomes.inc({ outcome: continuationResult.retry.outcome });
                }

                if (!continuationResult.success) {
                  this.logger.error("Failed to continue run execution", {
                    params,
                    statusCode: continuationResult.statusCode,
                    error: continuationResult.error,
                    attempts: continuationResult.retry?.attempts,
                    elapsedMs: continuationResult.retry?.elapsedMs,
                    outcome: continuationResult.retry?.outcome,
                    budgetMs: this.continueRetryBudget?.budgetMs,
                  });
                  reply.json(
                    {
                      ok: false,
                      error: "Failed to continue run execution",
                    },
                    false,
                    400
                  );
                  return;
                }

                const { runToken, secretProxy, ...continuation } = continuationResult.data;
                if (placement && this.secretProxy && secretProxy) {
                  try {
                    await this.secretProxy.activateContinue(caller, placement, {
                      ...continuation,
                      runToken,
                      secretProxy,
                    });
                  } catch (error) {
                    this.logger.error("Failed to bind continued secret proxy execution", {
                      params,
                      error,
                    });
                  }
                }
                reply.json(continuation as WorkloadContinueRunExecutionResponseBody);

                await this.cancelCheckpointsAfterReply(params.runFriendlyId);
              }
            ),
        }
      )
      .route(
        "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/since/:snapshotFriendlyId",
        "GET",
        {
          paramsSchema: WorkloadActionParams,
          handler: async (ctx) =>
            this.wideRoute(
              ctx,
              "snapshots.since",
              "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/since/:snapshotFriendlyId",
              "GET",
              async () => {
                const { req, reply, params } = ctx;
                const auth = await this.authorizeWorkloadRequest(req, params.runFriendlyId);
                if (!auth.ok) {
                  reply.empty(401);
                  return;
                }
                const sinceSnapshotResponse = await this.workerClient.getSnapshotsSince(
                  params.runFriendlyId,
                  params.snapshotFriendlyId,
                  this.runnerIdFromRequest(req),
                  auth.environmentId
                );

                if (!sinceSnapshotResponse.success) {
                  this.logger.error("Failed to get snapshots since", {
                    runId: params.runFriendlyId,
                    error: sinceSnapshotResponse.error,
                  });
                  reply.empty(500);
                  return;
                }

                reply.json({
                  snapshots: sinceSnapshotResponse.data.snapshots.map(legacifyCheckpointType),
                } satisfies WorkloadRunSnapshotsSinceResponseBody);
              },
              { highFrequency: true }
            ),
        }
      );

    if (env.SEND_RUN_DEBUG_LOGS) {
      httpServer.route("/api/v1/workload-actions/runs/:runFriendlyId/logs/debug", "POST", {
        paramsSchema: WorkloadDebugParams,
        bodySchema: CompiledWorkloadDebugLogRequestBody,
        handler: async (ctx) =>
          this.wideRoute(
            ctx,
            "logs.debug",
            "/api/v1/workload-actions/runs/:runFriendlyId/logs/debug",
            "POST",
            async () => {
              const { req, reply, params, body } = ctx;
              const auth = await this.authorizeWorkloadRequest(req, params.runFriendlyId);
              if (!auth.ok) {
                reply.empty(401);
                return;
              }
              reply.empty(204);

              // Redact TRIGGER_DEPLOYMENT_ID before relaying to the platform.
              const sanitizedBody =
                body.properties && "TRIGGER_DEPLOYMENT_ID" in body.properties
                  ? {
                      ...body,
                      properties: { ...body.properties, TRIGGER_DEPLOYMENT_ID: "[redacted]" },
                    }
                  : body;

              await this.workerClient.sendDebugLog(
                params.runFriendlyId,
                sanitizedBody,
                this.runnerIdFromRequest(req)
              );
            },
            { highFrequency: true }
          ),
      });
    } else {
      // Disabled: drop immediately without reading/parsing the body and without
      // any log we can't switch off. Older runners still POST per log line; the
      // route stays registered (an unregistered route would log "No route match"
      // per request) but sheds the request at minimal cost. Request metrics still
      // count it. 204 is non-retryable on the runner client, so no retry storm.
      httpServer.route("/api/v1/workload-actions/runs/:runFriendlyId/logs/debug", "POST", {
        paramsSchema: WorkloadDebugParams,
        skipBodyParsing: true,
        handler: async (ctx) => {
          ctx.reply.empty(204);
        },
      });
    }

    return httpServer;
  }

  private createWebsocketServer() {
    const io = new Server(this.httpServer.server);

    const websocketServer: Namespace<
      WorkloadClientToServerEvents,
      WorkloadServerToClientEvents,
      DefaultEventsMap,
      SupervisorSocketData
    > = io.of("/workload");

    websocketServer.on("disconnect", (socket) => {
      this.logger.verbose("[WS] disconnect", socket.id);
    });
    websocketServer.use(async (socket, next) => {
      const setSocketDataFromHeader = (
        dataKey: keyof WorkloadClientSocketData,
        headerName: string,
        required: boolean = true
      ) => {
        const value = socket.handshake.headers[headerName];

        if (value) {
          if (Array.isArray(value)) {
            if (value[0]) {
              socket.data[dataKey] = value[0];
              return;
            }
          } else {
            socket.data[dataKey] = value;
            return;
          }
        }

        if (required) {
          this.logger.error("[WS] missing required header", { headerName });
          throw new Error("missing header");
        }
      };

      try {
        setSocketDataFromHeader("deploymentId", WORKLOAD_HEADERS.DEPLOYMENT_ID);
        setSocketDataFromHeader("runnerId", WORKLOAD_HEADERS.RUNNER_ID);
      } catch (error) {
        this.logger.error("[WS] setSocketDataFromHeader error", { error });
        socket.disconnect(true);
        return;
      }

      if (workloadTokensEnabled) {
        const result = await verifyDeploymentIdHeader(socket.data.deploymentId, "ws");

        if (result.outcome === "jwt_invalid" && workloadTokenEnforced) {
          this.logger.error("[WS] deployment token verification failed", {
            runnerId: socket.data.runnerId,
          });
          socket.disconnect(true);
          return;
        }

        socket.data.workloadTokenKey = result.key;
        socket.data.workloadTokenRunCutoffMs = result.runCutoffMs;
        socket.data.workloadTokenClaims = result.claims;

        // Re-source the deployment id from the verified claim; the raw header may be an opaque token.
        // A legacy bare id is itself the friendlyId, so it's safe to keep.
        socket.data.deploymentFriendlyId =
          result.outcome === "jwt_valid"
            ? result.claims.deployment
            : result.outcome === "legacy_bare"
              ? socket.data.deploymentId
              : undefined;
      }

      this.logger.debug("[WS] handshake complete", {
        runnerId: socket.data.runnerId,
        deploymentFriendlyId: socket.data.deploymentFriendlyId,
      });

      next();
    });
    websocketServer.on("connection", (socket) => {
      const socketLogger = this.logger.child({
        socketId: socket.id,
        socketData: socket.data,
      });

      const getSocketMetadata = () => {
        return {
          deploymentId: socket.data.deploymentFriendlyId ?? socket.data.deploymentId,
          runId: socket.data.runFriendlyId,
          snapshotId: socket.data.snapshotId,
          runnerId: socket.data.runnerId,
        };
      };

      const emitSocketLifecycle = (
        event: "run_connected" | "run_disconnected",
        friendlyId: string,
        disconnectReason?: string
      ) => {
        emitOneShot({
          ...this.wideEventOpts,
          op: event === "run_connected" ? "socket.run.connected" : "socket.run.disconnected",
          kind: "event",
          populate: (state) => {
            state.extras.event = event;
            setMeta(state, "run_id", friendlyId);
            const deploymentId = socket.data.deploymentFriendlyId ?? socket.data.deploymentId;
            if (deploymentId) {
              setMeta(state, "deployment_id", deploymentId);
            }
            if (socket.data.runnerId) setMeta(state, "runner_id", socket.data.runnerId);
            state.extras.socket_id = socket.id;
            if (disconnectReason) state.extras.disconnect_reason = disconnectReason;
          },
        });
      };

      const runConnected = (friendlyId: string) => {
        if (!sandboxRunAllowed(friendlyId, socket.data.workloadTokenClaims)) return;
        socketLogger.debug("runConnected", { ...getSocketMetadata() });

        // Only the owning runner may (re)bind a run. A live socket from a *different*
        // runner keeps its binding so an unrelated connection can't hijack the run. But
        // the newest socket for the *same* runner is a legitimate reconnection/handoff and
        // is allowed to take over even while the stale socket still reports connected -
        // otherwise, during a reconnect race the fresh socket would silently stay unbound
        // (missing continue/cancel/suspend notifications) until the dead socket times out.
        const existing = this.runSockets.get(friendlyId);
        if (existing && existing.id !== socket.id && existing.connected) {
          const sameRunner =
            !!socket.data.runnerId && existing.data.runnerId === socket.data.runnerId;

          if (!sameRunner) {
            socketLogger.warn("runConnected: run already bound to another socket", {
              ...getSocketMetadata(),
              friendlyId,
              existingSocketId: existing.id,
            });
            return;
          }

          socketLogger.debug("runConnected: replacing stale socket for same runner", {
            ...getSocketMetadata(),
            friendlyId,
            existingSocketId: existing.id,
          });
        }

        // If there's already a run ID set, we should "disconnect" it from this socket
        if (socket.data.runFriendlyId && socket.data.runFriendlyId !== friendlyId) {
          socketLogger.debug("runConnected: disconnecting existing run", {
            ...getSocketMetadata(),
            newRunId: friendlyId,
            oldRunId: socket.data.runFriendlyId,
          });
          runDisconnected(socket.data.runFriendlyId, "socket_run_replaced");
        }

        this.runSockets.set(friendlyId, socket);
        this.emit("runConnected", { run: { friendlyId } });
        socket.data.runFriendlyId = friendlyId;
        emitSocketLifecycle("run_connected", friendlyId);
      };

      const runDisconnected = (friendlyId: string, reason: string) => {
        if (!sandboxRunAllowed(friendlyId, socket.data.workloadTokenClaims)) return;
        socketLogger.debug("runDisconnected", { ...getSocketMetadata() });

        // A newer socket may have taken over this run (same-runner reconnect race). If the
        // run is now bound to a different socket, this stale socket must not clear the fresh
        // binding or emit a spurious disconnect - just drop its own reference and bail.
        const bound = this.runSockets.get(friendlyId);
        if (bound && bound.id !== socket.id) {
          socketLogger.debug("runDisconnected: run rebound to another socket, skipping", {
            ...getSocketMetadata(),
            friendlyId,
            boundSocketId: bound.id,
          });
          if (socket.data.runFriendlyId === friendlyId) {
            socket.data.runFriendlyId = undefined;
          }
          return;
        }

        // The run left this runner, so its pending snapshot is stale; a genuine
        // suspension keeps the socket connected. The runnerId guard stops a stale
        // duplicate cancelling a fresh runner's snapshot. socket.data.runnerId is
        // fixed at the handshake, so after a same-supervisor restore (new runner id, same
        // socket) the cancel is refused: a missed cancel, never a wrong one. The
        // attempt.complete cancel uses the current header id and is unaffected.
        this.snapshotService?.cancel(friendlyId, socket.data.runnerId);

        this.runSockets.delete(friendlyId);
        this.emit("runDisconnected", { run: { friendlyId } });
        socket.data.runFriendlyId = undefined;
        emitSocketLifecycle("run_disconnected", friendlyId, reason);
      };

      const previousKeySocketMayBind = (friendlyId: string, eventName: "run:start" | "run:stop") =>
        socket.data.workloadTokenKey !== "previous" ||
        this.previousKeyRunAllowed(friendlyId, {
          transport: "ws",
          remoteAddress: socket.handshake.address,
          runnerId: socket.data.runnerId,
          userAgent: socket.handshake.headers["user-agent"],
          route: eventName,
          claims: socket.data.workloadTokenClaims,
          runCutoffMs: socket.data.workloadTokenRunCutoffMs,
        });

      socketLogger.debug("wsServer socket connected", { ...getSocketMetadata() });

      // FIXME: where does this get set?
      if (socket.data.runFriendlyId) {
        runConnected(socket.data.runFriendlyId);
      }

      socket.on("disconnecting", (reason, description) => {
        socketLogger.verbose("Socket disconnecting", {
          ...getSocketMetadata(),
          reason,
          description,
        });

        if (socket.data.runFriendlyId) {
          runDisconnected(socket.data.runFriendlyId, `socket_disconnecting:${reason}`);
        }
      });

      socket.on("disconnect", (reason, description) => {
        socketLogger.debug("Socket disconnected", { ...getSocketMetadata(), reason, description });
      });

      socket.on("error", (error) => {
        socketLogger.error("Socket error", {
          ...getSocketMetadata(),
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
          },
        });
      });

      socket.on("run:start", async (message) => {
        const log = socketLogger.child({
          eventName: "run:start",
          ...getSocketMetadata(),
          ...message,
        });

        log.debug("Handling run:start");

        try {
          const friendlyId = runFriendlyIdFromMessage(message);
          if (!previousKeySocketMayBind(friendlyId, "run:start")) {
            return;
          }
          runConnected(friendlyId);
        } catch (error) {
          log.error("run:start error", { error });
        }
      });

      socket.on("run:stop", async (message) => {
        const log = socketLogger.child({
          eventName: "run:stop",
          ...getSocketMetadata(),
          ...message,
        });

        log.debug("Handling run:stop");

        try {
          const friendlyId = runFriendlyIdFromMessage(message);
          if (!previousKeySocketMayBind(friendlyId, "run:stop")) {
            return;
          }
          runDisconnected(friendlyId, "run_stop_message");
        } catch (error) {
          log.error("run:stop error", { error });
        }
      });
    });

    return websocketServer;
  }

  private async waitForSecretProxyPlacement(
    caller: SecretProxyCaller,
    { continuing = false } = {}
  ): Promise<SecretProxyPlacement | undefined> {
    const secretProxy = this.secretProxy;
    if (!secretProxy) return;
    const deadline = performance.now() + SECRET_PROXY_PLACEMENT_WAIT_MS;
    let endWait: ReturnType<typeof secretProxyPlacementWait.startTimer> | undefined;
    let outcome = "unavailable";
    let retrying = false;
    let saturated = false;
    try {
      for (;;) {
        try {
          const placement = await secretProxy.prepareStart(caller, { continuing, retrying });
          if (placement) {
            outcome = "placed";
            return placement;
          }
          break;
        } catch (error) {
          if (!(error instanceof SecretProxyPlacementPendingError)) {
            if (!continuing) throw error;
            break;
          }
          saturated = error instanceof SecretProxyPlacementSaturatedError;
        }
        if (performance.now() + SECRET_PROXY_PLACEMENT_RETRY_MS >= deadline) {
          // "saturated": the wait ended on a full lookup queue, not on kubelet.
          outcome = saturated ? "saturated" : "timeout";
          break;
        }
        retrying = true;
        endWait ??= secretProxyPlacementWait.startTimer({
          route: continuing ? "continue" : "start",
        });
        await sleep(SECRET_PROXY_PLACEMENT_RETRY_MS);
      }
      if (continuing) unplacedSecretProxyContinues.inc();
      return;
    } finally {
      endWait?.({ outcome });
    }
  }

  private async revokeRunner(
    runnerId: string,
    uid: string,
    discovered?: SecretProxyAllocationBusyError["discovered"]
  ): Promise<void> {
    await this.secretProxy?.revokeRunner(runnerId, uid, discovered);
  }

  notifyRun({ run }: { run: { friendlyId: string } }) {
    try {
      const runSocket = this.runSockets.get(run.friendlyId);

      if (!runSocket) {
        this.logger.debug("notifyRun: Run socket not found", { run });

        this.workerClient.sendDebugLog(run.friendlyId, {
          time: new Date(),
          message: "run:notify socket not found on supervisor",
        });

        return;
      }

      runSocket.emit("run:notify", { version: "1", run });
      this.logger.debug("run:notify sent", { run });

      this.workerClient.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: "run:notify supervisor -> runner",
      });
    } catch (error) {
      this.logger.error("Error in notifyRun", { run, error });

      this.workerClient.sendDebugLog(run.friendlyId, {
        time: new Date(),
        message: "run:notify error on supervisor",
      });
    }
  }

  async start() {
    await this.secretProxy?.start();
    await this.httpServer.start();
  }

  async stop() {
    this.snapshotService?.stop();
    await this.secretProxy?.stop();
    // An open socket would hold the close until the shutdown timeout. Drop the transports
    // rather than disconnect the sockets, which would stop runners reconnecting.
    this.websocketServer.server.engine.close();
    await this.httpServer.stop();
  }
}
