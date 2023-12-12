import type { PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { CreateRunService } from "~/services/runs/createRun.server";
import { DispatchableSchema } from "~/models/eventDispatcher.server";
import { InvokeEphemeralDispatcherService } from "../dispatchers/invokeEphemeralEventDispatcher.server";

export class InvokeDispatcherService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, eventRecordIds: string[]) {
    const eventDispatcher = await this.#prismaClient.eventDispatcher.findUniqueOrThrow({
      where: {
        id,
      },
      include: {
        batcher: true,
        environment: {
          include: {
            project: true,
            organization: true,
          },
        },
      },
    });

    if (!eventDispatcher.enabled) {
      logger.debug("Event dispatcher is disabled", {
        eventDispatcher,
      });

      return;
    }

    const eventRecords = await this.#prismaClient.eventRecord.findMany({
      where: {
        id: { in: eventRecordIds },
      },
      select: {
        id: true,
        eventId: true,
      },
    });

    if (!eventRecords.length) {
      logger.debug("No event records found", {
        eventDispatcher,
        eventRecordIds,
      });

      return;
    }

    logger.debug("Invoking event dispatcher", {
      eventDispatcher,
      eventRecordIds,
    });

    const dispatchable = DispatchableSchema.safeParse(eventDispatcher.dispatchable);

    if (!dispatchable.success) {
      logger.debug("Invalid dispatchable", {
        eventDispatcher,
        errors: dispatchable.error.flatten(),
      });

      return;
    }

    switch (dispatchable.data.type) {
      case "JOB_VERSION": {
        const jobVersion = await this.#prismaClient.jobVersion.findUniqueOrThrow({
          where: {
            id: dispatchable.data.id,
          },
          include: {
            job: true,
          },
        });

        const createRunService = new CreateRunService(this.#prismaClient);

        await createRunService.call({
          batched: !!eventDispatcher.batcher,
          eventIds: eventRecords.map((e) => e.eventId),
          job: jobVersion.job,
          version: jobVersion,
          environment: eventDispatcher.environment,
        });

        break;
      }
      case "DYNAMIC_TRIGGER": {
        const dynamicTrigger = await this.#prismaClient.dynamicTrigger.findUniqueOrThrow({
          where: {
            id: dispatchable.data.id,
          },
          include: {
            endpoint: {
              include: {
                environment: {
                  include: {
                    project: true,
                    organization: true,
                  },
                },
              },
            },
            jobs: true,
          },
        });

        for (const job of dynamicTrigger.jobs) {
          const latestJobVersion = await this.#prismaClient.jobVersion.findFirst({
            where: {
              jobId: job.id,
              aliases: {
                some: {
                  name: "latest",
                },
              },
              environmentId: dynamicTrigger.endpoint.environmentId,
            },
            orderBy: { createdAt: "desc" },
            take: 1,
          });

          if (!latestJobVersion) {
            continue;
          }

          const createRunService = new CreateRunService(this.#prismaClient);

          await createRunService.call({
            batched: !!eventDispatcher.batcher,
            eventIds: eventRecords.map((e) => e.eventId),
            job: job,
            version: latestJobVersion,
            environment: eventDispatcher.environment,
          });
        }

        break;
      }
      case "EPHEMERAL": {
        if (eventRecords.length > 1) {
          throw new Error("Ephemeral dispatcher unsupported when batching is enabled.");
        }

        await InvokeEphemeralDispatcherService.enqueue(eventDispatcher.id, eventRecords[0].id);

        break;
      }
    }
  }
}
