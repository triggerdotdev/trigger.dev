import { Prisma, PrismaClient, prisma } from "~/db.server";
import { CreateRunService } from "../runs/createRun.server";

export class ReRunService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ runId }: { runId: string }) {
    try {
      return await this.#prismaClient.$transaction(async (tx) => {
        //get the run info required for a rerun
        const existingRun = await tx.jobRun.findUniqueOrThrow({
          include: {
            organization: true,
            project: true,
            environment: true,
            version: true,
            job: true,
            event: true,
            externalAccount: true,
          },
          where: {
            id: runId,
          },
        });

        const eventIds = existingRun.eventIds.length
          ? existingRun.eventIds
          : [existingRun.event.id];

        const eventRecords = await this.#prismaClient.eventRecord.findMany({
          where: {
            id: { in: eventIds },
          },
        });

        if (eventIds.length !== eventRecords.length) {
          throw new Error(
            `Event records don't match. Found ${eventRecords.length}, expected ${eventIds.length}`
          );
        }

        const eventLogs = await Promise.all(
          eventRecords.map((event) =>
            this.#prismaClient.eventRecord.create({
              data: {
                organizationId: existingRun.environment.organizationId,
                projectId: existingRun.environment.projectId,
                environmentId: existingRun.environment.id,
                externalAccountId: existingRun.externalAccount?.id,
                eventId: `${event.id}:retry:${new Date().getTime()}`,
                name: event.name,
                timestamp: new Date(),
                payload: event.payload ?? {},
                context: event.context ?? {},
                source: event.source,
                isTest: event.isTest,
              },
              select: {
                id: true,
              },
            })
          )
        );

        const createRunService = new CreateRunService(tx);

        return createRunService.call({
          environment: {
            ...existingRun.environment,
            organization: existingRun.organization,
            project: existingRun.project,
          },
          eventIds: eventLogs.map((e) => e.id),
          job: existingRun.job,
          version: existingRun.version,
          batched: existingRun.batched,
        });
      });
    } catch (error) {
      throw error;
    }
  }
}
