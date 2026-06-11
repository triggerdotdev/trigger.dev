import { type Namespace, Server, type Socket } from "socket.io";
import { SimpleStructuredLogger } from "@trigger.dev/core/v3/utils/structuredLogger";
import EventEmitter from "node:events";
import { z } from "zod";
import {
  type SupervisorHttpClient,
  WORKLOAD_HEADERS,
  type WorkloadClientSocketData,
  type WorkloadClientToServerEvents,
  type WorkloadContinueRunExecutionResponseBody,
  WorkloadDebugLogRequestBody,
  type WorkloadDequeueFromVersionResponseBody,
  WorkloadHeartbeatRequestBody,
  type WorkloadHeartbeatResponseBody,
  WorkloadRunAttemptCompleteRequestBody,
  type WorkloadRunAttemptCompleteResponseBody,
  WorkloadRunAttemptStartRequestBody,
  type WorkloadRunAttemptStartResponseBody,
  WorkloadRunSnapshotsSinceResponseBody,
  type WorkloadServerToClientEvents,
  type WorkloadSuspendRunResponseBody,
} from "@trigger.dev/core/v3/workers";
import { HttpServer, type CheckpointClient } from "@trigger.dev/core/v3/serverOnly";
import { type IncomingMessage } from "node:http";
import { register } from "../metrics.js";
import { env } from "../env.js";
import { SnapshotCallbackPayloadSchema } from "@internal/compute";
import {
  ComputeSnapshotService,
  type RunTraceContext,
} from "../services/computeSnapshotService.js";
import type { ComputeWorkloadManager } from "../workloadManager/compute.js";
import type { OtlpTraceService } from "../services/otlpTraceService.js";
import type { ServerResponse } from "node:http";
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

const WorkloadActionParams = z.object({
  runFriendlyId: z.string(),
  snapshotFriendlyId: z.string(),
});

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
  computeManager?: ComputeWorkloadManager;
  tracing?: OtlpTraceService;
  wideEventOpts: WideEventOptions;
  /** When true, high-frequency HTTP routes also emit wide events. */
  wideEventsNoisyRoutes: boolean;
};

export class WorkloadServer extends EventEmitter<WorkloadServerEvents> {
  private checkpointClient?: CheckpointClient;
  private readonly snapshotService?: ComputeSnapshotService;

  private readonly logger = new SimpleStructuredLogger("workload-server");
  private readonly wideEventOpts: WideEventOptions;
  private readonly wideEventsNoisyRoutes: boolean;

  private readonly httpServer: HttpServer;
  private readonly websocketServer: Namespace<
    WorkloadClientToServerEvents,
    WorkloadServerToClientEvents,
    DefaultEventsMap,
    WorkloadClientSocketData
  >;

  private readonly runSockets = new Map<
    string,
    Socket<
      WorkloadClientToServerEvents,
      WorkloadServerToClientEvents,
      DefaultEventsMap,
      WorkloadClientSocketData
    >
  >();

  private readonly workerClient: SupervisorHttpClient;

  constructor(opts: WorkloadServerOptions) {
    super();

    const host = opts.host ?? "0.0.0.0";
    const port = opts.port;

    this.workerClient = opts.workerClient;
    this.checkpointClient = opts.checkpointClient;
    this.wideEventOpts = opts.wideEventOpts;
    this.wideEventsNoisyRoutes = opts.wideEventsNoisyRoutes;

    if (opts.computeManager?.snapshotsEnabled) {
      this.snapshotService = new ComputeSnapshotService({
        computeManager: opts.computeManager,
        workerClient: opts.workerClient,
        tracing: opts.tracing,
        wideEventOpts: this.wideEventOpts,
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

  private createHttpServer({ host, port }: { host: string; port: number }) {
    const httpServer = new HttpServer({
      port,
      host,
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
          bodySchema: WorkloadRunAttemptStartRequestBody,
          handler: async (ctx) =>
            this.wideRoute(
              ctx,
              "attempt.start",
              "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/attempts/start",
              "POST",
              async () => {
                const { req, reply, params, body } = ctx;
                const startResponse = await this.workerClient.startRunAttempt(
                  params.runFriendlyId,
                  params.snapshotFriendlyId,
                  body,
                  this.runnerIdFromRequest(req)
                );

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
          handler: async (ctx) =>
            this.wideRoute(
              ctx,
              "attempt.complete",
              "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/attempts/complete",
              "POST",
              async () => {
                const { req, reply, params, body } = ctx;
                const runnerId = this.runnerIdFromRequest(req);
                const completeResponse = await this.workerClient.completeRunAttempt(
                  params.runFriendlyId,
                  params.snapshotFriendlyId,
                  body,
                  runnerId
                );

                // A completion attempt invalidates any pending delayed snapshot
                // regardless of outcome: the runner has finished executing, so the
                // suspended state the snapshot was scheduled to capture no longer
                // exists. Without this, the snapshot fires up to snapshotDelayMs
                // later and pauses a VM that has long moved on - and on a transient
                // completion failure the runner retries, so waiting for success
                // would leave the stale snapshot armed in the meantime. The
                // runnerId guard keeps a stale duplicate runner's failed completion
                // from cancelling a fresh runner's snapshot.
                this.snapshotService?.cancel(params.runFriendlyId, runnerId);

                if (!completeResponse.success) {
                  this.logger.error("Failed to complete run", {
                    params,
                    error: completeResponse.error,
                  });
                  reply.empty(500);
                  return;
                }

                reply.json(
                  completeResponse.data satisfies WorkloadRunAttemptCompleteResponseBody
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
          bodySchema: WorkloadHeartbeatRequestBody,
          handler: async (ctx) =>
            this.wideRoute(
              ctx,
              "heartbeat",
              "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/heartbeat",
              "POST",
              async () => {
                const { req, reply, params, body } = ctx;
                const heartbeatResponse = await this.workerClient.heartbeatRun(
                  params.runFriendlyId,
                  params.snapshotFriendlyId,
                  body,
                  this.runnerIdFromRequest(req)
                );

                if (!heartbeatResponse.success) {
                  this.logger.error("Failed to heartbeat run", {
                    params,
                    error: heartbeatResponse.error,
                  });
                  reply.empty(500);
                  return;
                }

                reply.json({
                  ok: true,
                } satisfies WorkloadHeartbeatResponseBody);
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
                  // Compute mode: delay snapshot to avoid wasted work on short-lived waitpoints.
                  // If the run continues before the delay expires, the snapshot is cancelled.
                  reply.json({ ok: true } satisfies WorkloadSuspendRunResponseBody, false, 202);

                  this.snapshotService.schedule(params.runFriendlyId, {
                    runnerId,
                    runFriendlyId: params.runFriendlyId,
                    snapshotFriendlyId: params.snapshotFriendlyId,
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
                this.logger.debug("Run continuation request", { params });

                // Cancel any pending delayed snapshot for this run
                this.snapshotService?.cancel(params.runFriendlyId);

                const continuationResult = await this.workerClient.continueRunExecution(
                  params.runFriendlyId,
                  params.snapshotFriendlyId,
                  this.runnerIdFromRequest(req)
                );

                if (!continuationResult.success) {
                  this.logger.error("Failed to continue run execution", { params });
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

                reply.json(continuationResult.data as WorkloadContinueRunExecutionResponseBody);
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
                const sinceSnapshotResponse = await this.workerClient.getSnapshotsSince(
                  params.runFriendlyId,
                  params.snapshotFriendlyId,
                  this.runnerIdFromRequest(req)
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
      )
      .route("/api/v1/workload-actions/deployments/:deploymentId/dequeue", "GET", {
        paramsSchema: z.object({
          deploymentId: z.string(),
        }),

        handler: async (ctx) =>
          this.wideRoute(
            ctx,
            "deployment.dequeue",
            "/api/v1/workload-actions/deployments/:deploymentId/dequeue",
            "GET",
            async () => {
              const { req, reply, params } = ctx;
              const dequeueResponse = await this.workerClient.dequeueFromVersion(
                params.deploymentId,
                1,
                this.runnerIdFromRequest(req)
              );

              if (!dequeueResponse.success) {
                this.logger.error("Failed to get latest snapshot", {
                  deploymentId: params.deploymentId,
                  error: dequeueResponse.error,
                });
                reply.empty(500);
                return;
              }

              reply.json(
                dequeueResponse.data.map(legacifyCheckpointType) satisfies WorkloadDequeueFromVersionResponseBody
              );
            }
          ),
      });

    if (env.SEND_RUN_DEBUG_LOGS) {
      httpServer.route("/api/v1/workload-actions/runs/:runFriendlyId/logs/debug", "POST", {
        paramsSchema: WorkloadActionParams.pick({ runFriendlyId: true }),
        bodySchema: WorkloadDebugLogRequestBody,
        handler: async (ctx) =>
          this.wideRoute(
            ctx,
            "logs.debug",
            "/api/v1/workload-actions/runs/:runFriendlyId/logs/debug",
            "POST",
            async () => {
              const { req, reply, params, body } = ctx;
              reply.empty(204);

              await this.workerClient.sendDebugLog(
                params.runFriendlyId,
                body,
                this.runnerIdFromRequest(req)
              );
            },
            { highFrequency: true }
          ),
      });
    } else {
      // Lightweight mock route without schemas
      httpServer.route("/api/v1/workload-actions/runs/:runFriendlyId/logs/debug", "POST", {
        handler: async (ctx) =>
          this.wideRoute(
            ctx,
            "logs.debug",
            "/api/v1/workload-actions/runs/:runFriendlyId/logs/debug",
            "POST",
            async () => {
              ctx.reply.empty(204);
            },
            { highFrequency: true }
          ),
      });
    }

    // Snapshot callback endpoint (inbound from compute path)
    httpServer.route("/api/v1/compute/snapshot-complete", "POST", {
      bodySchema: SnapshotCallbackPayloadSchema,
      handler: async (ctx) =>
        this.wideRoute(ctx, "snapshot.callback", "/api/v1/compute/snapshot-complete", "POST", async () => {
          const { reply, body } = ctx;
          if (!this.snapshotService) {
            reply.empty(404);
            return;
          }

          const result = await this.snapshotService.handleCallback(body);
          reply.empty(result.status);
        }),
    });

    return httpServer;
  }

  private createWebsocketServer() {
    const io = new Server(this.httpServer.server);

    const websocketServer: Namespace<
      WorkloadClientToServerEvents,
      WorkloadServerToClientEvents,
      DefaultEventsMap,
      WorkloadClientSocketData
    > = io.of("/workload");

    websocketServer.on("disconnect", (socket) => {
      this.logger.verbose("[WS] disconnect", socket.id);
    });
    websocketServer.use(async (socket, next) => {
      const setSocketDataFromHeader = (
        dataKey: keyof typeof socket.data,
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

      this.logger.debug("[WS] auth success", socket.data);

      next();
    });
    websocketServer.on("connection", (socket) => {
      const socketLogger = this.logger.child({
        socketId: socket.id,
        socketData: socket.data,
      });

      const getSocketMetadata = () => {
        return {
          deploymentId: socket.data.deploymentId,
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
            if (socket.data.deploymentId) {
              setMeta(state, "deployment_id", socket.data.deploymentId);
            }
            if (socket.data.runnerId) setMeta(state, "runner_id", socket.data.runnerId);
            state.extras.socket_id = socket.id;
            if (disconnectReason) state.extras.disconnect_reason = disconnectReason;
          },
        });
      };

      const runConnected = (friendlyId: string) => {
        socketLogger.debug("runConnected", { ...getSocketMetadata() });

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
        socketLogger.debug("runDisconnected", { ...getSocketMetadata() });

        // The run is gone from this runner (crash, exit, or replaced by a new
        // run), so a pending delayed snapshot for it is stale. Genuine
        // waitpoint suspensions keep the socket connected, so this doesn't
        // cancel a snapshot that's still wanted; the runnerId match guards
        // against a stale duplicate runner cancelling a fresh runner's
        // snapshot after the run was reassigned. Caveat: socket.data.runnerId
        // is frozen at the websocket handshake, so after a same-supervisor
        // restore (new runner id, socket not recreated) this guard refuses
        // the cancel - a missed cancel, never a wrong one. The
        // attempt.complete cancel uses the runner's current HTTP header id
        // and is unaffected.
        this.snapshotService?.cancel(friendlyId, socket.data.runnerId);

        this.runSockets.delete(friendlyId);
        this.emit("runDisconnected", { run: { friendlyId } });
        socket.data.runFriendlyId = undefined;
        emitSocketLifecycle("run_disconnected", friendlyId, reason);
      };

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
          runConnected(message.run.friendlyId);
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
          runDisconnected(message.run.friendlyId, "run_stop_message");
          // Don't delete trace context here - run:stop fires after each snapshot/shutdown
          // but the run may be restored on a new VM and snapshot again. Trace context is
          // re-populated on dequeue, and entries are small (4 strings per run).
        } catch (error) {
          log.error("run:stop error", { error });
        }
      });
    });

    return websocketServer;
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

  registerRunTraceContext(runFriendlyId: string, ctx: RunTraceContext) {
    this.snapshotService?.registerTraceContext(runFriendlyId, ctx);
  }

  async start() {
    await this.httpServer.start();
  }

  async stop() {
    this.snapshotService?.stop();
    await this.httpServer.stop();
  }
}
