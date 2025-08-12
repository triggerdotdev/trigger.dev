import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  ApiDeploymentListSearchParams,
  InitializeDeploymentRequestBody,
  InitializeDeploymentResponseBody,
} from "@trigger.dev/core/v3";
import { $replica } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { InitializeDeploymentService } from "~/v3/services/initializeDeployment.server";

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const rawBody = await request.json();
  const body = InitializeDeploymentRequestBody.safeParse(rawBody);

  if (!body.success) {
    return json({ error: "Invalid body", issues: body.error.issues }, { status: 400 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const service = new InitializeDeploymentService();

  try {
    const { deployment, imageRef } = await service.call(authenticatedEnv, body.data);

    const responseBody: InitializeDeploymentResponseBody = {
      id: deployment.friendlyId,
      contentHash: deployment.contentHash,
      shortCode: deployment.shortCode,
      version: deployment.version,
      externalBuildData:
        deployment.externalBuildData as InitializeDeploymentResponseBody["externalBuildData"],
      imageTag: imageRef,
      imagePlatform: deployment.imagePlatform,
    };

    return json(responseBody, { status: 200 });
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return json({ error: error.message }, { status: 400 });
    } else if (error instanceof Error) {
      logger.error("Error initializing deployment", { error: error.message });
      return json({ error: `Internal server error: ${error.message}` }, { status: 500 });
    } else {
      logger.error("Error initializing deployment", { error: String(error) });
      return json({ error: "Internal server error" }, { status: 500 });
    }
  }
}

export const loader = createLoaderApiRoute(
  {
    searchParams: ApiDeploymentListSearchParams,
    allowJWT: true,
    corsStrategy: "none",
    authorization: {
      action: "read",
      resource: () => ({ deployments: "list" }),
      superScopes: ["read:deployments", "read:all", "admin"],
    },
    findResource: async () => 1, // This is a dummy function, we don't need to find a resource
  },
  async ({ searchParams, authentication }) => {
    const limit = Math.max(Math.min(searchParams["page[size]"] ?? 20, 100), 5);

    const afterDeployment = searchParams["page[after]"]
      ? await $replica.workerDeployment.findFirst({
          where: {
            friendlyId: searchParams["page[after]"],
            environmentId: authentication.environment.id,
          },
        })
      : undefined;

    const deployments = await $replica.workerDeployment.findMany({
      where: {
        environmentId: authentication.environment.id,
        ...(afterDeployment ? { id: { lt: afterDeployment.id } } : {}),
        ...getCreatedAtFilter(searchParams),
        ...(searchParams.status ? { status: searchParams.status } : {}),
      },
      orderBy: {
        id: "desc",
      },
      take: limit + 1,
    });

    const hasMore = deployments.length > limit;
    const nextCursor = hasMore ? deployments[limit - 1].friendlyId : undefined;
    const data = hasMore ? deployments.slice(0, limit) : deployments;

    return json({
      data: data.map((deployment) => ({
        id: deployment.friendlyId,
        createdAt: deployment.createdAt,
        shortCode: deployment.shortCode,
        version: deployment.version.toString(),
        runtime: deployment.runtime,
        runtimeVersion: deployment.runtimeVersion,
        status: deployment.status,
        deployedAt: deployment.deployedAt,
        git: deployment.git,
        error: deployment.errorData ?? undefined,
      })),
      pagination: {
        next: nextCursor,
      },
    });
  }
);

import parseDuration from "parse-duration";

function getCreatedAtFilter(searchParams: ApiDeploymentListSearchParams) {
  if (searchParams.period) {
    const duration = parseDuration(searchParams.period, "ms");

    if (!duration) {
      throw new ServiceValidationError(
        `Invalid search query parameter: period=${searchParams.period}`,
        400
      );
    }

    return {
      createdAt: {
        gte: new Date(Date.now() - duration),
        lte: new Date(),
      },
    };
  }

  if (searchParams.from && searchParams.to) {
    const fromDate = safeDateFromString(searchParams.from, "from");
    const toDate = safeDateFromString(searchParams.to, "to");

    return {
      createdAt: {
        gte: fromDate,
        lte: toDate,
      },
    };
  }

  if (searchParams.from) {
    const fromDate = safeDateFromString(searchParams.from, "from");
    return {
      createdAt: {
        gte: fromDate,
      },
    };
  }

  return {};
}

function safeDateFromString(value: string, paramName: string) {
  const date = new Date(value);
  if (isNaN(date.getTime())) {
    throw new ServiceValidationError(`Invalid search query parameter: ${paramName}=${value}`, 400);
  }
  return date;
}
