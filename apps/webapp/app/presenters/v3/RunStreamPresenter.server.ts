import { type PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { singleton } from "~/utils/singleton";
import { ABORT_REASON_SEND_ERROR, createSSELoader, SendFunction } from "~/utils/sse";
import { throttle } from "~/utils/throttle";
import { getMollifierBuffer } from "~/v3/mollifier/mollifierBuffer.server";
import { deserialiseMollifierSnapshot } from "~/v3/mollifier/mollifierSnapshot.server";
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

        const userId = await requireUserId(context.request);

        // Scope the lookup to organizations the requesting user is a member
        // of, matching RunPresenter's run lookup. Unauthorized and missing
        // runs are indistinguishable (both 404).
        const run = await prismaClient.taskRun.findFirst({
          where: {
            friendlyId: runFriendlyId,
            project: {
              organization: {
                members: {
                  some: {
                    userId,
                  },
                },
              },
            },
          },
          select: {
            traceId: true,
          },
        });

        // Fall back to the mollifier buffer when the run isn't in PG yet.
        // The buffered run has no execution events to stream, but we still
        // attach a trace-pubsub subscription using the snapshot's traceId
        // so that the moment the drainer materialises the row and execution
        // begins, those events flow to this open SSE connection. Closing
        // with 404 would force the dashboard to keep retrying.
        let traceId: string | null = run?.traceId ?? null;
        if (!traceId) {
          const buffer = getMollifierBuffer();
          if (buffer) {
            try {
              const entry = await buffer.getEntry(runFriendlyId);
              // Same membership scoping as the PG lookup above — the buffer
              // entry carries the owning org's id.
              const isMember = entry
                ? (await prismaClient.orgMember.findFirst({
                    where: { organizationId: entry.orgId, userId },
                    select: { id: true },
                  })) !== null
                : false;
              if (entry && isMember) {
                // Go through the webapp wrapper so this read-side module
                // shares a single deserialisation path with readFallback —
                // see the contract comment in syntheticRedirectInfo.server.ts.
                const snapshot = deserialiseMollifierSnapshot(entry.payload);
                if (typeof snapshot.traceId === "string") {
                  traceId = snapshot.traceId;
                }
              }
            } catch (err) {
              logger.warn("RunStreamPresenter buffer fallback failed", {
                runFriendlyId,
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        if (!traceId) {
          throw new Response("Not found", { status: 404 });
        }
        const resolvedRun = { traceId };

        logger.info("RunStreamPresenter.start", {
          runFriendlyId,
          traceId: resolvedRun.traceId,
        });

        // Subscribe to trace updates
        const { unsubscribe, eventEmitter } = await tracePubSub.subscribeToTrace(resolvedRun.traceId);

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
              // Abort the stream on send error. Uses a stackless string sentinel
              // from sse.ts — a no-arg abort() would create a DOMException with a
              // stack trace, which is unnecessary retention on the signal.reason.
              context.controller.abort(ABORT_REASON_SEND_ERROR);
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
              traceId: resolvedRun.traceId,
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
                  traceId: resolvedRun.traceId,
                });
              })
              .catch((error) => {
                logger.error("RunStreamPresenter.cleanup.unsubscribe failed", {
                  runFriendlyId,
                  traceId: resolvedRun.traceId,
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
