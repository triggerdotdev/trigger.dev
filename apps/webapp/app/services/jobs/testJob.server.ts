import { EventSpecificationSchema } from "@/../../packages/internal/src";
import { PrismaClient, prisma } from "~/db.server";
import { CreateRunService } from "../runs/createRun.server";

export class TestJobService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environmentId,
    versionId,
    payload,
  }: {
    environmentId: string;
    versionId: string;
    payload: any;
  }) {
    try {
      return await this.#prismaClient.$transaction(async (tx) => {
        //get the environment with orgId and projectId
        const environment = await tx.runtimeEnvironment.findUniqueOrThrow({
          include: {
            organization: true,
            project: true,
          },
          where: {
            id: environmentId,
          },
        });

        const version = await tx.jobVersion.findUniqueOrThrow({
          include: {
            job: true,
          },
          where: {
            id: versionId,
          },
        });

        const event = EventSpecificationSchema.parse(
          version.eventSpecification
        );

        const eventLog = await this.#prismaClient.eventRecord.create({
          data: {
            organization: {
              connect: {
                id: environment.organizationId,
              },
            },
            project: {
              connect: {
                id: environment.projectId,
              },
            },
            environment: {
              connect: {
                id: environment.id,
              },
            },
            eventId: `test:${event.name}:${new Date().getTime()}`,
            name: event.name,
            timestamp: new Date(),
            payload: payload ?? {},
            context: {},
            source: event.source ?? "trigger.dev",
            isTest: true,
          },
        });

        const createRunService = new CreateRunService(tx);
        return createRunService.call({
          environment,
          eventId: eventLog.id,
          job: version.job,
          version,
        });
      });
    } catch (error) {
      throw error;
    }
  }
}
