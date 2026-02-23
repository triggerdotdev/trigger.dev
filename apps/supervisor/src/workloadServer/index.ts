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
import type { ComputeWorkloadManager } from "../workloadManager/compute.js";

// Use the official export when upgrading to socket.io@4.8.0
interface DefaultEventsMap {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [event: string]: (...args: any[]) => void;
}

const WorkloadActionParams = z.object({
  runFriendlyId: z.string(),
  snapshotFriendlyId: z.string(),
});

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

const ComputeSnapshotCallbackBody = z.object({
  snapshot_id: z.string(),
  instance_id: z.string(),
  status: z.enum(["completed", "failed"]),
  error: z.string().optional(),
  metadata: z.record(z.string()).optional(),
});

type WorkloadServerOptions = {
  port: number;
  host?: string;
  workerClient: SupervisorHttpClient;
  checkpointClient?: CheckpointClient;
  computeManager?: ComputeWorkloadManager;
};

export class WorkloadServer extends EventEmitter<WorkloadServerEvents> {
  private checkpointClient?: CheckpointClient;
  private computeManager?: ComputeWorkloadManager;

  private readonly logger = new SimpleStructuredLogger("workload-server");

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
    this.computeManager = opts.computeManager;

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
          handler: async ({ req, reply, params, body }) => {
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
          },
        }
      )
      .route(
        "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/attempts/complete",
        "POST",
        {
          paramsSchema: WorkloadActionParams,
          bodySchema: WorkloadRunAttemptCompleteRequestBody,
          handler: async ({ req, reply, params, body }) => {
            const completeResponse = await this.workerClient.completeRunAttempt(
              params.runFriendlyId,
              params.snapshotFriendlyId,
              body,
              this.runnerIdFromRequest(req)
            );

            if (!completeResponse.success) {
              this.logger.error("Failed to complete run", {
                params,
                error: completeResponse.error,
              });
              reply.empty(500);
              return;
            }

            reply.json(completeResponse.data satisfies WorkloadRunAttemptCompleteResponseBody);
            return;
          },
        }
      )
      .route(
        "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/heartbeat",
        "POST",
        {
          paramsSchema: WorkloadActionParams,
          bodySchema: WorkloadHeartbeatRequestBody,
          handler: async ({ req, reply, params, body }) => {
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
        }
      )
      .route(
        "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/suspend",
        "GET",
        {
          paramsSchema: WorkloadActionParams,
          handler: async ({ reply, params, req }) => {
            this.logger.debug("Suspend request", { params, headers: req.headers });

            const runnerId = this.runnerIdFromRequest(req);
            const deploymentVersion = this.deploymentVersionFromRequest(req);
            const projectRef = this.projectRefFromRequest(req);

            if (!runnerId || !deploymentVersion || !projectRef) {
              this.logger.error("Invalid headers for suspend request", {
                ...params,
                headers: req.headers,
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

            if (this.computeManager && env.COMPUTE_SNAPSHOTS_ENABLED) {
              if (!env.TRIGGER_WORKLOAD_API_DOMAIN) {
                this.logger.error(
                  "TRIGGER_WORKLOAD_API_DOMAIN is not set, cannot create snapshot callback URL"
                );
                reply.json({ error: "Snapshot callbacks not configured" }, false, 500);
                return;
              }

              // Compute mode: fire-and-forget snapshot with callback
              reply.json({ ok: true } satisfies WorkloadSuspendRunResponseBody, false, 202);

              const callbackUrl = `${env.TRIGGER_WORKLOAD_API_PROTOCOL}://${env.TRIGGER_WORKLOAD_API_DOMAIN}:${env.TRIGGER_WORKLOAD_API_PORT_EXTERNAL}/api/v1/compute/snapshot-complete`;

              const snapshotResult = await this.computeManager.snapshot({
                runnerId,
                callbackUrl,
                metadata: {
                  runId: params.runFriendlyId,
                  snapshotFriendlyId: params.snapshotFriendlyId,
                },
              });

              if (!snapshotResult) {
                this.logger.error("Failed to request compute snapshot", { params, runnerId });
              }

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
          },
        }
      )
      .route(
        "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/continue",
        "GET",
        {
          paramsSchema: WorkloadActionParams,
          handler: async ({ req, reply, params }) => {
            this.logger.debug("Run continuation request", { params });

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
          },
        }
      )
      .route(
        "/api/v1/workload-actions/runs/:runFriendlyId/snapshots/since/:snapshotFriendlyId",
        "GET",
        {
          paramsSchema: WorkloadActionParams,
          handler: async ({ req, reply, params }) => {
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

            reply.json(sinceSnapshotResponse.data satisfies WorkloadRunSnapshotsSinceResponseBody);
          },
        }
      )
      .route("/api/v1/workload-actions/deployments/:deploymentId/dequeue", "GET", {
        paramsSchema: z.object({
          deploymentId: z.string(),
        }),

        handler: async ({ req, reply, params }) => {
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

          reply.json(dequeueResponse.data satisfies WorkloadDequeueFromVersionResponseBody);
        },
      });

    if (env.SEND_RUN_DEBUG_LOGS) {
      httpServer.route("/api/v1/workload-actions/runs/:runFriendlyId/logs/debug", "POST", {
        paramsSchema: WorkloadActionParams.pick({ runFriendlyId: true }),
        bodySchema: WorkloadDebugLogRequestBody,
        handler: async ({ req, reply, params, body }) => {
          reply.empty(204);

          await this.workerClient.sendDebugLog(
            params.runFriendlyId,
            body,
            this.runnerIdFromRequest(req)
          );
        },
      });
    } else {
      // Lightweight mock route without schemas
      httpServer.route("/api/v1/workload-actions/runs/:runFriendlyId/logs/debug", "POST", {
        handler: async ({ reply }) => {
          reply.empty(204);
        },
      });
    }

    // Compute snapshot callback endpoint
    httpServer.route("/api/v1/compute/snapshot-complete", "POST", {
      bodySchema: ComputeSnapshotCallbackBody,
      handler: async ({ reply, body }) => {
        this.logger.info("Compute snapshot callback", {
          snapshotId: body.snapshot_id,
          instanceId: body.instance_id,
          status: body.status,
          error: body.error,
          metadata: body.metadata,
        });

        const runId = body.metadata?.runId;
        const snapshotFriendlyId = body.metadata?.snapshotFriendlyId;

        if (!runId || !snapshotFriendlyId) {
          this.logger.error("Compute snapshot callback missing metadata", { body });
          reply.empty(400);
          return;
        }

        if (body.status === "completed") {
          const result = await this.workerClient.submitSuspendCompletion({
            runId,
            snapshotId: snapshotFriendlyId,
            body: {
              success: true,
              checkpoint: {
                type: "KUBERNETES",
                location: body.snapshot_id,
              },
            },
          });

          if (result.success) {
            this.logger.info("Suspend completion submitted, deleting instance", {
              runId,
              instanceId: body.instance_id,
            });
            await this.computeManager?.deleteInstance(body.instance_id);
          } else {
            this.logger.error("Failed to submit suspend completion", {
              runId,
              snapshotFriendlyId,
              error: result.error,
            });
          }
        } else {
          const result = await this.workerClient.submitSuspendCompletion({
            runId,
            snapshotId: snapshotFriendlyId,
            body: {
              success: false,
              error: body.error ?? "Snapshot failed",
            },
          });

          if (!result.success) {
            this.logger.error("Failed to submit suspend failure", {
              runId,
              snapshotFriendlyId,
              error: result.error,
            });
          }
        }

        reply.empty(200);
      },
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
      this.logger.log("[WS] disconnect", socket.id);
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

      const runConnected = (friendlyId: string) => {
        socketLogger.debug("runConnected", { ...getSocketMetadata() });

        // If there's already a run ID set, we should "disconnect" it from this socket
        if (socket.data.runFriendlyId && socket.data.runFriendlyId !== friendlyId) {
          socketLogger.debug("runConnected: disconnecting existing run", {
            ...getSocketMetadata(),
            newRunId: friendlyId,
            oldRunId: socket.data.runFriendlyId,
          });
          runDisconnected(socket.data.runFriendlyId);
        }

        this.runSockets.set(friendlyId, socket);
        this.emit("runConnected", { run: { friendlyId } });
        socket.data.runFriendlyId = friendlyId;
      };

      const runDisconnected = (friendlyId: string) => {
        socketLogger.debug("runDisconnected", { ...getSocketMetadata() });

        this.runSockets.delete(friendlyId);
        this.emit("runDisconnected", { run: { friendlyId } });
        socket.data.runFriendlyId = undefined;
      };

      socketLogger.log("wsServer socket connected", { ...getSocketMetadata() });

      // FIXME: where does this get set?
      if (socket.data.runFriendlyId) {
        runConnected(socket.data.runFriendlyId);
      }

      socket.on("disconnecting", (reason, description) => {
        socketLogger.log("Socket disconnecting", { ...getSocketMetadata(), reason, description });

        if (socket.data.runFriendlyId) {
          runDisconnected(socket.data.runFriendlyId);
        }
      });

      socket.on("disconnect", (reason, description) => {
        socketLogger.log("Socket disconnected", { ...getSocketMetadata(), reason, description });
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

        log.log("Handling run:start");

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

        log.log("Handling run:stop");

        try {
          runDisconnected(message.run.friendlyId);
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

  async start() {
    await this.httpServer.start();
  }

  async stop() {
    await this.httpServer.stop();
  }
}
