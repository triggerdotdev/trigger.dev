import { PrismaClient } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requestUrl } from "~/utils/requestUrl.server";
import { logger } from "../logger.server";
import { json } from "@remix-run/server-runtime";
import { RequestFilterSchema, requestFilterMatches } from "@trigger.dev/core";

export const HttpEndpointParamsSchema = z.object({
  httpEndpointId: z.string(),
  envType: z.string(),
  shortcode: z.string(),
});

type HttpEndpointParams = z.infer<typeof HttpEndpointParamsSchema>;

export class HandleHttpEndpointService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(params: HttpEndpointParams, request: Request) {
    const httpEndpoint = await this.#prismaClient.triggerHttpEndpoint.findUnique({
      where: {
        id: params.httpEndpointId,
      },
      include: {
        secretReference: true,
        project: {
          include: {
            environments: {
              where: {
                shortcode: params.shortcode,
              },
            },
          },
        },
      },
    });

    if (!httpEndpoint) {
      logger.error("Could not find http endpoint", { httpEndpointId: params.httpEndpointId });
      return json(
        { error: true, message: "Could not find http endpoint" },
        {
          status: 404,
        }
      );
    }

    if (!httpEndpoint.project.environments.length) {
      logger.error("Could not find environment", { shortcode: params.shortcode });
      return json({ error: true, message: "Could not find environment" }, { status: 404 });
    }

    const httpEndpointEnvironment =
      await this.#prismaClient.triggerHttpEndpointEnvironment.findUnique({
        where: {
          environmentId_httpEndpointId: {
            environmentId: httpEndpoint.project.environments[0].id,
            httpEndpointId: httpEndpoint.id,
          },
        },
      });

    if (!httpEndpointEnvironment) {
      logger.error("Could not find http endpoint environment", {
        httpEndpointId: httpEndpoint.id,
        environmentId: httpEndpoint.project.environments[0].id,
      });
      return json(
        { error: true, message: "Could not find http endpoint environment" },
        { status: 404 }
      );
    }

    const immediateResponseFilter = RequestFilterSchema.safeParse(
      httpEndpointEnvironment.immediateResponseFilter
    );
    if (!immediateResponseFilter.success) {
      logger.error("Could not parse immediate response filter", {
        httpEndpointId: httpEndpoint.id,
        environmentId: httpEndpoint.project.environments[0].id,
        errors: immediateResponseFilter.error,
      });
      return json(
        { error: true, message: "Could not parse immediate response filter" },
        { status: 500 }
      );
    }

    //todo don't store the payload if an immediate response is required?

    //test against the filter
    const callClientImmediately = await requestFilterMatches(request, immediateResponseFilter.data);
    if (callClientImmediately) {
      return json({ message: "Should call client immediately" }, { status: 200 });
    }

    //todo either generate events, or schedule a Job to call the client to generate events
    //todo store the request? where?

    return new Response(undefined, {
      status: 200,
    });
  }
}
