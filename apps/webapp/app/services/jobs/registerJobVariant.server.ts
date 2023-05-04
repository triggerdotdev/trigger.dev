import type {
  TriggerVariantConfig,
  TriggerVariantResponseBody,
} from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import type { ApiConnectionWithSecretReference } from "../externalApis/apiAuthenticationRepository.server";
import { resolveApiConnection } from "~/models/jobConnection.server";

export class RegisterJobVariantService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    endpointSlug,
    jobId,
    jobVersion,
    config: { trigger, id },
    environment,
  }: {
    environment: AuthenticatedEnvironment;
    endpointSlug: string;
    jobId: string;
    jobVersion: string;
    config: TriggerVariantConfig;
  }): Promise<TriggerVariantResponseBody> {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        environmentId_slug: {
          environmentId: environment.id,
          slug: endpointSlug,
        },
      },
    });

    const jobInstance = await this.#prismaClient.jobInstance.findUniqueOrThrow({
      where: {
        jobId_version_endpointId: {
          jobId,
          version: jobVersion,
          endpointId: endpoint.id,
        },
      },
    });

    let apiConnection: ApiConnectionWithSecretReference | undefined;

    if (trigger.connection && trigger.connection.auth === "hosted") {
      apiConnection = await this.#prismaClient.apiConnection.findUniqueOrThrow({
        where: {
          organizationId_slug: {
            organizationId: endpoint.organizationId,
            slug: trigger.connection.id,
          },
        },
        include: {
          dataReference: true,
        },
      });
    }

    const triggerVariant = await this.#prismaClient.jobTriggerVariant.upsert({
      where: {
        jobInstanceId_slug: {
          jobInstanceId: jobInstance.id,
          slug: id,
        },
      },
      create: {
        jobInstance: {
          connect: {
            id: jobInstance.id,
          },
        },
        slug: id,
        data: trigger,
        ready: !trigger.supportsPreparation,
        eventRule: {
          create: {
            event: trigger.eventRule.event,
            source: trigger.eventRule.source,
            payloadFilter: trigger.eventRule.payload,
            contextFilter: trigger.eventRule.context,
            jobId: jobInstance.jobId,
            jobInstanceId: jobInstance.id,
            environmentId: environment.id,
            organizationId: environment.organizationId,
            projectId: environment.projectId,
            enabled: true,
            actionIdentifier: `__trigger_${id}`,
          },
        },
      },
      update: {
        data: trigger,
      },
    });

    return {
      id: triggerVariant.id,
      slug: triggerVariant.slug,
      data: trigger,
      ready: triggerVariant.ready,
      auth: await resolveApiConnection(apiConnection),
    };
  }
}
