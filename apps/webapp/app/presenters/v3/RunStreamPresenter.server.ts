import { TaskRun } from "@trigger.dev/database";
import { eventStream } from "remix-utils/sse/server";
import { PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { throttle } from "~/utils/throttle";
import { eventRepository } from "~/v3/eventRepository.server";

const pingInterval = 1000;

export class RunStreamPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    request,
    runFriendlyId,
  }: {
    request: Request;
    runFriendlyId: TaskRun["friendlyId"];
  }) {
    const run = await this.#prismaClient.taskRun.findFirst({
      where: {
        friendlyId: runFriendlyId,
      },
      select: {
        traceId: true,
      },
    });

    if (!run) {
      return new Response("Not found", { status: 404 });
    }

    logger.info("RunStreamPresenter.call", {
      runFriendlyId,
      traceId: run.traceId,
    });

    let pinger: NodeJS.Timeout | undefined = undefined;

    const { unsubscribe, eventEmitter } = await eventRepository.subscribeToTrace(run.traceId);

    return eventStream(request.signal, (send, close) => {
      const safeSend = (args: { event?: string; data: string }) => {
        try {
          send(args);
        } catch (error) {
          if (error instanceof Error) {
            if (error.name !== "TypeError") {
              logger.debug("Error sending SSE, aborting", {
                error: {
                  name: error.name,
                  message: error.message,
                  stack: error.stack,
                },
                args,
              });
            }
          } else {
            logger.debug("Unknown error sending SSE, aborting", {
              error,
              args,
            });
          }

          close();
        }
      };

      const throttledSend = throttle(safeSend, 1000);

      eventEmitter.addListener("message", (event) => {
        throttledSend({ data: event });
      });

      pinger = setInterval(() => {
        if (request.signal.aborted) {
          return close();
        }

        safeSend({ event: "ping", data: new Date().toISOString() });
      }, pingInterval);

      return function clear() {
        logger.info("RunStreamPresenter.abort", {
          runFriendlyId,
          traceId: run.traceId,
        });

        clearInterval(pinger);

        eventEmitter.removeAllListeners();

        unsubscribe()
          .then(() => {
            logger.info("RunStreamPresenter.abort.unsubscribe succeeded", {
              runFriendlyId,
              traceId: run.traceId,
            });
          })
          .catch((error) => {
            logger.error("RunStreamPresenter.abort.unsubscribe failed", {
              runFriendlyId,
              traceId: run.traceId,
              error: {
                name: error.name,
                message: error.message,
                stack: error.stack,
              },
            });
          });
      };
    });
  }
}
