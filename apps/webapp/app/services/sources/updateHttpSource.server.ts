import type { Organization, RuntimeEnvironment } from ".prisma/client";
import {
  HttpEventSource,
  UpdateHttpEventSourceBody,
} from "@trigger.dev/internal";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { env } from "~/env.server";

export class UpdateHttpSourceService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    environment,
    payload,
    id,
  }: {
    environment: RuntimeEnvironment;
    payload: UpdateHttpEventSourceBody;
    id: string;
  }): Promise<HttpEventSource> {
    const httpSource = await this.#prismaClient.httpSource.findFirst({
      where: {
        id,
        environmentId: environment.id,
      },
    });

    if (!httpSource) {
      throw new Error("HttpSource does not exist");
    }

    const updatedHttpSource = await this.#prismaClient.httpSource.update({
      where: {
        id,
      },
      data: {
        secret: payload.secret,
        data: JSON.parse(JSON.stringify(payload.data)),
        active: payload.active ?? undefined,
        connectionId: payload.connectionId,
      },
    });

    return {
      id: updatedHttpSource.id,
      active: updatedHttpSource.active,
      secret: updatedHttpSource.secret ?? undefined,
      data: updatedHttpSource.data,
      url: `${env.APP_ORIGIN}/api/v3/sources/http/${updatedHttpSource.id}`,
      connectionId: updatedHttpSource.connectionId ?? undefined,
    };
  }
}
