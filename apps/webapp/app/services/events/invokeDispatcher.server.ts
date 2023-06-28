import { z } from "zod";
import type { PrismaClientOrTransaction } from "~/db.server";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { CreateRunService } from "~/services/runs/createRun.server";

const JobVersionDispatchableSchema = z.object({
  type: z.literal("JOB_VERSION"),
  id: z.string(),
});

const DynamicTriggerDispatchableSchema = z.object({
  type: z.literal("DYNAMIC_TRIGGER"),
  id: z.string(),
});

const DispatchableSchema = z.discriminatedUnion("type", [
  JobVersionDispatchableSchema,
  DynamicTriggerDispatchableSchema,
]);

export class InvokeDispatcherService {
  #prismaClient: PrismaClientOrTransaction;

  constructor(prismaClient: PrismaClientOrTransaction = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string, eventRecordId: string) {
    const eventDispatcher =
      await this.#prismaClient.eventDispatcher.findUniqueOrThrow({
        where: {
          id,
        },
        include: {
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

    const eventRecord = await this.#prismaClient.eventRecord.findUniqueOrThrow({
      where: {
        id: eventRecordId,
      },
    });

    logger.debug("Invoking event dispatcher", {
      eventDispatcher,
      eventRecord: eventRecord.id,
    });

    const dispatchable = DispatchableSchema.safeParse(
      eventDispatcher.dispatchable
    );

    if (!dispatchable.success) {
      logger.debug("Invalid dispatchable", {
        eventDispatcher,
        errors: dispatchable.error.flatten(),
      });

      return;
    }

    switch (dispatchable.data.type) {
      case "JOB_VERSION": {
        const jobVersion =
          await this.#prismaClient.jobVersion.findUniqueOrThrow({
            where: {
              id: dispatchable.data.id,
            },
            include: {
              job: true,
            },
          });

        const createRunService = new CreateRunService(this.#prismaClient);

        await createRunService.call({
          eventId: eventRecord.id,
          job: jobVersion.job,
          version: jobVersion,
          environment: eventDispatcher.environment,
        });

        break;
      }
      case "DYNAMIC_TRIGGER": {
        const dynamicTrigger =
          await this.#prismaClient.dynamicTrigger.findUniqueOrThrow({
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
          const latestJobVersion =
            await this.#prismaClient.jobVersion.findFirst({
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
            eventId: eventRecord.id,
            job: job,
            version: latestJobVersion,
            environment: eventDispatcher.environment,
          });
        }

        break;
      }
    }
  }
}
