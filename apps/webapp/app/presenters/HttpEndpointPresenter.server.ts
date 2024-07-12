import { z } from "zod";
import { type PrismaClient, prisma } from "~/db.server";
import { sortEnvironments } from "~/utils/environmentSort";
import { httpEndpointUrl } from "~/services/httpendpoint/HandleHttpEndpointService";
import { getSecretStore } from "~/services/secrets/secretStore.server";
import { projectPath } from "~/utils/pathBuilder";

export class HttpEndpointPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    httpEndpointKey,
  }: {
    userId: string;
    projectSlug: string;
    organizationSlug: string;
    httpEndpointKey: string;
  }) {
    const httpEndpoint = await this.#prismaClient.triggerHttpEndpoint.findFirst({
      select: {
        id: true,
        key: true,
        icon: true,
        title: true,
        updatedAt: true,
        projectId: true,
        secretReference: {
          select: {
            key: true,
            provider: true,
          },
        },
        httpEndpointEnvironments: {
          select: {
            id: true,
            immediateResponseFilter: true,
            skipTriggeringRuns: true,
            source: true,
            active: true,
            updatedAt: true,
            environment: {
              select: {
                type: true,
                orgMember: {
                  select: {
                    userId: true,
                  },
                },
              },
            },
          },
        },
        webhook: {
          select: {
            id: true,
            key: true,
          },
        },
      },
      where: {
        key: httpEndpointKey,
        project: {
          slug: projectSlug,
          organization: {
            members: {
              some: {
                userId,
              },
            },
          },
        },
      },
    });

    if (!httpEndpoint) {
      throw new Error("Could not find http endpoint");
    }

    const environments = await this.#prismaClient.runtimeEnvironment.findMany({
      select: {
        id: true,
        type: true,
        slug: true,
        shortcode: true,
        orgMember: {
          select: {
            userId: true,
          },
        },
      },
      where: {
        projectId: httpEndpoint.projectId,
      },
    });

    const relevantEnvironments = sortEnvironments(
      environments
        .filter(
          (environment) => environment.orgMember === null || environment.orgMember.userId === userId
        )
        .map((environment) => ({
          ...environment,
          webhookUrl: httpEndpointUrl({ httpEndpointId: httpEndpoint.id, environment }),
        }))
    );

    //get the secret
    const secretStore = getSecretStore(httpEndpoint.secretReference.provider);
    let secret: string | undefined;
    try {
      const secretData = await secretStore.getSecretOrThrow(
        z.object({ secret: z.string() }),
        httpEndpoint.secretReference.key
      );
      secret = secretData.secret;
    } catch (e) {
      let error = e instanceof Error ? e.message : JSON.stringify(e);
      throw new Error(`Could not retrieve secret: ${error}`);
    }
    if (!secret) {
      throw new Error("Could not find secret");
    }

    const httpEndpointEnvironments = httpEndpoint.httpEndpointEnvironments
      .filter(
        (httpEndpointEnvironment) =>
          httpEndpointEnvironment.environment.orgMember === null ||
          httpEndpointEnvironment.environment.orgMember.userId === userId
      )
      .map((endpointEnv) => ({
        ...endpointEnv,
        immediateResponseFilter: endpointEnv.immediateResponseFilter != null,
        environment: {
          type: endpointEnv.environment.type,
        },
        webhookUrl: relevantEnvironments.find((e) => e.type === endpointEnv.environment.type)
          ?.webhookUrl,
      }));

    const projectRootPath = projectPath({ slug: organizationSlug }, { slug: projectSlug });

    return {
      httpEndpoint: {
        ...httpEndpoint,
        httpEndpointEnvironments,
        webhookLink: httpEndpoint.webhook
          ? `${projectRootPath}/triggers/webhooks/${httpEndpoint.webhook.id}`
          : undefined,
      },
      environments: relevantEnvironments,
      unconfiguredEnvironments: relevantEnvironments.filter(
        (e) => httpEndpointEnvironments.find((h) => h.environment.type === e.type) === undefined
      ),
      secret,
    };
  }
}
