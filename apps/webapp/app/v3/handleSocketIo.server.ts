import type { EventBusEventArgs } from "@internal/run-engine";
import { createAdapter } from "@socket.io/redis-adapter";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import type {
  WorkerClientToServerEvents,
  WorkerServerToClientEvents,
} from "@trigger.dev/core/v3/workers";
import { defaultReconnectOnError } from "@internal/redis";
import { Redis } from "ioredis";
import type { Namespace, Socket } from "socket.io";
import { Server } from "socket.io";
import { env } from "~/env.server";
import { authenticateApiRequestWithFailure } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { recordRunDebugLog } from "./eventRepository/index.server";
import { engine } from "./runEngine.server";
import { WorkerGroupTokenService } from "./services/worker/workerGroupTokenService.server";

export const socketIo = singleton("socketIo", initalizeIoServer);

function initalizeIoServer() {
  const io = initializeSocketIOServerInstance();

  io.on("connection", (socket) => {
    logger.log(`[socket.io][${socket.id}] connection at url: ${socket.request.url}`);
  });

  const workerNamespace = createWorkerNamespace({
    io,
    namespace: "/worker",
    authenticate: async (request) => {
      const tokenService = new WorkerGroupTokenService();
      const authenticatedInstance = await tokenService.authenticate(request);
      if (!authenticatedInstance) {
        return false;
      }
      return true;
    },
  });
  const devWorkerNamespace = createWorkerNamespace({
    io,
    namespace: "/dev-worker",
    authenticate: async (request) => {
      const authentication = await authenticateApiRequestWithFailure(request);
      if (!authentication.ok) {
        return false;
      }
      if (authentication.environment.type !== "DEVELOPMENT") {
        return false;
      }
      return true;
    },
  });

  return {
    io,
    workerNamespace,
    devWorkerNamespace,
  };
}

function initializeSocketIOServerInstance() {
  if (env.REDIS_HOST && env.REDIS_PORT) {
    const pubClient = new Redis({
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      reconnectOnError: defaultReconnectOnError,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    });
    const subClient = pubClient.duplicate();

    const io = new Server({
      adapter: createAdapter(pubClient, subClient, {
        key: "tr:socket.io:",
        publishOnSpecificResponseChannel: true,
      }),
    });

    return io;
  }

  return new Server();
}

function headersFromHandshake(handshake: Socket["handshake"]) {
  const headers = new Headers();

  for (const [key, value] of Object.entries(handshake.headers)) {
    if (typeof value !== "string") continue;
    headers.append(key, value);
  }

  return headers;
}

function createWorkerNamespace({
  io,
  namespace,
  authenticate,
}: {
  io: Server;
  namespace: string;
  authenticate: (request: Request) => Promise<boolean>;
}) {
  const worker: Namespace<WorkerClientToServerEvents, WorkerServerToClientEvents> =
    io.of(namespace);

  worker.use(async (socket, next) => {
    try {
      const headers = headersFromHandshake(socket.handshake);

      logger.debug("Worker authentication", {
        namespace,
        socketId: socket.id,
        headers: Object.fromEntries(headers),
      });

      const request = new Request("https://example.com", {
        headers,
      });

      const success = await authenticate(request);

      if (!success) {
        throw new Error("unauthorized");
      }

      next();
    } catch (error) {
      // System handles auth failure by disconnecting the socket — not an
      // error. Most volume is V1 /dev-worker reconnect churn from outdated
      // CLIs anyway.
      logger.warn("Worker authentication failed", {
        namespace,
        error: error instanceof Error ? error.message : error,
      });

      socket.disconnect(true);
    }
  });

  worker.on("connection", async (socket) => {
    logger.debug("worker connected", { namespace, socketId: socket.id });

    const rooms = new Set<string>();

    async function onNotification({
      time,
      run,
      snapshot,
    }: EventBusEventArgs<"workerNotification">[0]) {
      if (!env.RUN_ENGINE_DEBUG_WORKER_NOTIFICATIONS) {
        return;
      }

      logger.debug("[handleSocketIo] Received worker notification", {
        namespace,
        time,
        runId: run.id,
        snapshot,
      });

      // Record notification event
      await recordRunDebugLog(run.id, `run:notify workerNotification event`, {
        attributes: {
          properties: {
            snapshotId: snapshot.id,
            snapshotStatus: snapshot.executionStatus,
            rooms: Array.from(rooms),
          },
        },
        startTime: time,
      });
    }

    engine.eventBus.on("workerNotification", onNotification);

    const interval = setInterval(() => {
      logger.debug("Rooms for socket", {
        namespace,
        socketId: socket.id,
        rooms: Array.from(rooms),
      });
    }, 5000);

    socket.on("disconnect", (reason, description) => {
      logger.debug("worker disconnected", {
        namespace,
        socketId: socket.id,
        reason,
        description,
      });
      clearInterval(interval);

      engine.eventBus.off("workerNotification", onNotification);
    });

    socket.on("disconnecting", (reason, description) => {
      logger.debug("worker disconnecting", {
        namespace,
        socketId: socket.id,
        reason,
        description,
      });
      clearInterval(interval);
    });

    socket.on("error", (error) => {
      logger.error("worker error", {
        namespace,
        socketId: socket.id,
        error: JSON.parse(JSON.stringify(error)),
      });
      clearInterval(interval);
    });

    socket.on("run:subscribe", async ({ version, runFriendlyIds }) => {
      logger.debug("run:subscribe", { namespace, version, runFriendlyIds });

      const settledResult = await Promise.allSettled(
        runFriendlyIds.map(async (friendlyId) => {
          const room = roomFromFriendlyRunId(friendlyId);

          logger.debug("Joining room", { namespace, room });

          socket.join(room);
          rooms.add(room);

          await recordRunDebugLog(
            RunId.fromFriendlyId(friendlyId),
            "run:subscribe received by platform",
            {
              attributes: {
                properties: {
                  friendlyId,
                  runFriendlyIds,
                  room,
                },
              },
            }
          );
        })
      );

      for (const result of settledResult) {
        if (result.status === "rejected") {
          logger.error("Error joining room", {
            namespace,
            runFriendlyIds,
            error: result.reason instanceof Error ? result.reason.message : result.reason,
          });
        }
      }

      logger.debug("Rooms for socket after subscribe", {
        namespace,
        socketId: socket.id,
        rooms: Array.from(rooms),
      });
    });

    socket.on("run:unsubscribe", async ({ version, runFriendlyIds }) => {
      logger.debug("run:unsubscribe", { namespace, version, runFriendlyIds });

      const settledResult = await Promise.allSettled(
        runFriendlyIds.map(async (friendlyId) => {
          const room = roomFromFriendlyRunId(friendlyId);

          logger.debug("Leaving room", { namespace, room });

          socket.leave(room);
          rooms.delete(room);

          await recordRunDebugLog(
            RunId.fromFriendlyId(friendlyId),
            "run:unsubscribe received by platform",
            {
              attributes: {
                properties: {
                  friendlyId,
                  runFriendlyIds,
                  room,
                },
              },
            }
          );
        })
      );

      for (const result of settledResult) {
        if (result.status === "rejected") {
          logger.error("Error leaving room", {
            namespace,
            runFriendlyIds,
            error: result.reason instanceof Error ? result.reason.message : result.reason,
          });
        }
      }

      logger.debug("Rooms for socket after unsubscribe", {
        namespace,
        socketId: socket.id,
        rooms: Array.from(rooms),
      });
    });
  });

  return worker;
}

export function roomFromFriendlyRunId(id: string) {
  return `room:${id}`;
}
