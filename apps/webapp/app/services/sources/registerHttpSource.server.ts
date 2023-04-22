import type { Organization, RuntimeEnvironment } from ".prisma/client";
import {
  HttpEventSource,
  RegisterHttpEventSourceBody,
} from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";

export class RegisterHttpSourceService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    organization,
    payload,
    endpointSlug,
  }: {
    environment: RuntimeEnvironment;
    organization: Organization;
    payload: RegisterHttpEventSourceBody;
    endpointSlug: string;
  }): Promise<HttpEventSource> {
    const endpoint = await this.#prismaClient.endpoint.findUniqueOrThrow({
      where: {
        environmentId_slug: {
          environmentId: environment.id,
          slug: endpointSlug,
        },
      },
    });

    const httpSource = await this.#prismaClient.httpSource.upsert({
      where: {
        key_endpointId: {
          key: payload.key,
          endpointId: endpoint.id,
        },
      },
      create: {
        key: payload.key,
        endpointId: endpoint.id,
        organizationId: organization.id,
        environmentId: environment.id,
        connectionId: payload.connectionId,
      },
      update: {
        connectionId: payload.connectionId,
      },
    });

    return {
      id: httpSource.id,
      active: httpSource.active,
      secret: httpSource.secret ?? undefined,
      data: httpSource.data,
      url: `${env.APP_ORIGIN}/api/v3/sources/http/${httpSource.id}`,
      connectionId: httpSource.connectionId ?? undefined,
    };
  }
}
