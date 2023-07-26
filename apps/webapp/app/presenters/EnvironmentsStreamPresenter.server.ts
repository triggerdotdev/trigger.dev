import { PrismaClient, prisma } from "~/db.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { sse } from "~/utils/sse";

type EnvironmentSignalsMap = {
  [x: string]: {
    lastUpdatedAt: number;
    lastTotalEndpointUpdatedTime: number;
    lastTotalIndexingUpdatedTime: number;
  };
};

export class EnvironmentsStreamPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    request,
    userId,
    projectSlug,
  }: {
    request: Request;
    userId: User["id"];
    projectSlug: Project["slug"];
  }) {
    let lastEnvironmentSignals: EnvironmentSignalsMap;

    return sse({
      request,
      run: async (send, stop) => {
        const nextEnvironmentSignals = await this.#runForUpdates({
          userId,
          projectSlug,
        });

        if (!nextEnvironmentSignals) {
          return stop();
        }

        const lastEnvironmentIds = lastEnvironmentSignals
          ? Object.keys(lastEnvironmentSignals)
          : [];
        const nextEnvironmentIds = Object.keys(nextEnvironmentSignals);

        if (
          //push update if the number of environments is different
          nextEnvironmentIds.length !== lastEnvironmentIds.length ||
          //push update if the list of ids is different
          lastEnvironmentIds.some((id) => !nextEnvironmentSignals[id]) ||
          nextEnvironmentIds.some((id) => !lastEnvironmentSignals[id]) ||
          //push update if any signals changed
          nextEnvironmentIds.some(
            (id) =>
              nextEnvironmentSignals[id].lastUpdatedAt !==
                lastEnvironmentSignals[id].lastUpdatedAt ||
              nextEnvironmentSignals[id].lastTotalEndpointUpdatedTime !==
                lastEnvironmentSignals[id].lastTotalEndpointUpdatedTime ||
              nextEnvironmentSignals[id].lastTotalIndexingUpdatedTime !==
                lastEnvironmentSignals[id].lastTotalIndexingUpdatedTime
          )
        ) {
          send({ data: new Date().toISOString() });
        }

        lastEnvironmentSignals = nextEnvironmentSignals;
      },
    });
  }

  async #runForUpdates({
    userId,
    projectSlug,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
  }) {
    const environments = await this.#prismaClient.runtimeEnvironment.findMany({
      select: {
        id: true,
        updatedAt: true,
        endpoints: {
          select: {
            updatedAt: true,
            indexings: {
              select: {
                updatedAt: true,
              },
            },
          },
        },
      },
      where: {
        project: {
          slug: projectSlug,
        },
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    if (!environments) return null;

    const environmentSignalsMap = environments.reduce<EnvironmentSignalsMap>(
      (acc, environment) => {
        const lastUpdatedAt = environment.updatedAt.getTime();
        const lastTotalEndpointUpdatedTime = environment.endpoints.reduce(
          (prev, endpoint) => prev + endpoint.updatedAt.getTime(),
          0
        );
        const lastTotalIndexingUpdatedTime = environment.endpoints.reduce(
          (prev, endpoint) =>
            prev +
            endpoint.indexings.reduce(
              (prev, indexing) => prev + indexing.updatedAt.getTime(),
              0
            ),
          0
        );

        return {
          ...acc,
          [environment.id]: {
            lastUpdatedAt,
            lastTotalEndpointUpdatedTime,
            lastTotalIndexingUpdatedTime,
          },
        };
      },
      {}
    );

    return environmentSignalsMap;
  }
}
