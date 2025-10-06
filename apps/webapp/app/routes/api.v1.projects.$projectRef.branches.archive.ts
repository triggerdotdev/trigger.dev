import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateRequest } from "~/services/apiAuth.server";
import { ArchiveBranchService } from "~/services/archiveBranch.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

const BodySchema = z.object({
  branch: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  logger.info("Archive branch", { url: request.url, params });

  const authenticationResult = await authenticateRequest(request, {
    personalAccessToken: true,
    organizationAccessToken: true,
    apiKey: false,
  });

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef } = parsedParams.data;

  const [error, body] = await tryCatch(request.json());
  if (error) {
    return json({ error: error.message }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: parsed.error.message }, { status: 400 });
  }

  const environments = await prisma.runtimeEnvironment.findMany({
    select: {
      id: true,
      archivedAt: true,
    },
    where: {
      organization:
        authenticationResult.type === "organizationAccessToken"
          ? { id: authenticationResult.result.organizationId }
          : {
              members: {
                some: {
                  userId: authenticationResult.result.userId,
                },
              },
            },
      project: {
        externalRef: projectRef,
      },
      branchName: parsed.data.branch,
    },
  });

  if (environments.length === 0) {
    return json({ error: "Branch not found" }, { status: 404 });
  }

  const environment = environments.find((env) => env.archivedAt === null);
  if (!environment) {
    return json({ error: "Branch already archived" }, { status: 400 });
  }

  const service = new ArchiveBranchService();
  const result = await service.call(
    authenticationResult.type === "organizationAccessToken"
      ? { type: "orgId", organizationId: authenticationResult.result.organizationId }
      : { type: "userMembership", userId: authenticationResult.result.userId },
    {
      environmentId: environment.id,
    }
  );

  if (result.success) {
    return json(result);
  } else {
    return json(result, { status: 400 });
  }
}
