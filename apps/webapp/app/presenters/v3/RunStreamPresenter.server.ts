import { type PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { createSSELoader, SendFunction } from "~/utils/sse";
import { throttle } from "~/utils/throttle";
import { tracePubSub } from "~/v3/services/tracePubSub.server";

const PING_INTERVAL = 5_000;
const STREAM_TIMEOUT = 30_000;

export class RunStreamPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public createLoader() {
    const prismaClient = this.#prismaClient;

    return createSSELoader({
      timeout: STREAM_TIMEOUT,
      interval: PING_INTERVAL,
      handler: async (context) => {
        const runFriendlyId = context.params.runParam;

        if (!runFriendlyId) {
          throw new Response("Missing runParam", { status: 400 });
        }

        const run = await prismaClient.taskRun.findFirst({
          where: {
            friendlyId: runFriendlyId,
          },
          select: {
            traceId: true,
          },
        });

        if (!run) {
          throw new Response("Not found", { status: 404 });
        }

        logger.info("RunStreamPresenter.start", {
          runFriendlyId,
          traceId: run.traceId,
        });

        // Subscribe to trace updates
        const { unsubscribe, eventEmitter } = await tracePubSub.subscribeToTrace(run.traceId);

        // Only send max every 1 second
        const throttledSend = throttle(
          (args: { send: SendFunction; event?: string; data: string }) => {
            try {
              args.send({ event: args.event, data: args.data });
            } catch (error) {
              if (error instanceof Error) {
                if (error.name !== "TypeError") {
                  logger.debug("Error sending SSE in RunStreamPresenter", {
                    error: {
                      name: error.name,
                      message: error.message,
                      stack: error.stack,
                    },
                  });
                }
              }
              // Abort the stream on send error
              context.controller.abort("Send error");
            }
          },
          1000
        );

        let messageListener: ((event: string) => void) | undefined;

        return {
          initStream: ({ send }) => {
            // Create throttled send function
            throttledSend({ send, event: "message", data: new Date().toISOString() });

            // Set up message listener for pub/sub events
            messageListener = (event: string) => {
              throttledSend({ send, event: "message", data: event });
            };
            eventEmitter.addListener("message", messageListener);

            context.debug("Subscribed to trace pub/sub");
          },

          iterator: ({ send }) => {
            // Send ping to keep connection alive
            try {
              // Send an actual message so the client refreshes
              throttledSend({ send, event: "message", data: new Date().toISOString() });
            } catch (error) {
              // If we can't send a ping, the connection is likely dead
              return false;
            }
          },

          cleanup: () => {
            logger.info("RunStreamPresenter.cleanup", {
              runFriendlyId,
              traceId: run.traceId,
            });

            // Remove message listener
            if (messageListener) {
              eventEmitter.removeListener("message", messageListener);
            }
            eventEmitter.removeAllListeners();

            // Unsubscribe from Redis pub/sub
            unsubscribe()
              .then(() => {
                logger.info("RunStreamPresenter.cleanup.unsubscribe succeeded", {
                  runFriendlyId,
                  traceId: run.traceId,
                });
              })
              .catch((error) => {
                logger.error("RunStreamPresenter.cleanup.unsubscribe failed", {
                  runFriendlyId,
                  traceId: run.traceId,
                  error: {
                    name: error.name,
                    message: error.message,
                    stack: error.stack,
                  },
                });
              });
          },
        };
      },
    });
  }
}

// Export a singleton loader for the route to use
export const runStreamLoader = singleton("runStreamLoader", () => {
  const presenter = new RunStreamPresenter();
  return presenter.createLoader();
});
