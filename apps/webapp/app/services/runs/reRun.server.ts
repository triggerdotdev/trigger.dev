import { PrismaClient, prisma } from "~/db.server";
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
          },
          where: {
            id: runId,
          },
        });

        const eventLog = await this.#prismaClient.eventRecord.create({
          data: {
            organization: {
              connect: {
                id: existingRun.environment.organizationId,
              },
            },
            project: {
              connect: {
                id: existingRun.environment.projectId,
              },
            },
            environment: {
              connect: {
                id: existingRun.environment.id,
              },
            },
            eventId: `${existingRun.event.eventId}:retry:${new Date().getTime()}`,
            name: existingRun.event.name,
            timestamp: new Date(),
            payload: existingRun.event.payload ?? {},
            context: existingRun.event.context ?? {},
            source: existingRun.event.source,
            isTest: existingRun.event.isTest,
          },
        });

        const createRunService = new CreateRunService(tx);

        return createRunService.call({
          environment: {
            ...existingRun.environment,
            organization: existingRun.organization,
            project: existingRun.project,
          },
          eventId: eventLog.id,
          job: existingRun.job,
          version: existingRun.version,
        });
      });
    } catch (error) {
      throw error;
    }
  }
}
