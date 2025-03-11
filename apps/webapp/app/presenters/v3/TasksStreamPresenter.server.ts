import { type TaskRunAttempt } from "@trigger.dev/database";
import { eventStream } from "remix-utils/sse/server";
import { type PrismaClient, prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { projectPubSub } from "~/v3/services/projectPubSub.server";

type RunWithAttempts = {
  updatedAt: Date;
  attempts: {
    status: TaskRunAttempt["status"];
    updatedAt: Date;
  }[];
};

const pingInterval = 1000;

export class TasksStreamPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    request,
    organizationSlug,
    projectSlug,
    environmentSlug,
    userId,
  }: {
    request: Request;
    organizationSlug: string;
    projectSlug: string;
    environmentSlug: string;
    userId: string;
  }) {
    const project = await this.#prismaClient.project.findFirst({
      where: {
        slug: projectSlug,
        organization: {
          slug: organizationSlug,
          members: {
            some: {
              userId,
            },
          },
        },
      },
      select: {
        id: true,
      },
    });

    if (!project) {
      return new Response("Not found", { status: 404 });
    }

    logger.info("TasksStreamPresenter.call", {
      projectSlug,
    });

    let pinger: NodeJS.Timeout | undefined = undefined;

    const subscriber = await projectPubSub.subscribe(`project:${project.id}:*`);

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

      subscriber.on("WORKER_CREATED", async (message) => {
        safeSend({ data: message.createdAt.toISOString() });
      });

      pinger = setInterval(() => {
        if (request.signal.aborted) {
          return close();
        }

        safeSend({ event: "ping", data: new Date().toISOString() });
      }, pingInterval);

      return async function clear() {
        logger.info("TasksStreamPresenter.abort", {
          projectSlug,
        });

        clearInterval(pinger);

        await subscriber.stopListening();
      };
    });
  }
}
