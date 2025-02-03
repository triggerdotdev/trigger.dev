import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { GetProjectResponseBody, GetProjectsResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  logger.info("get project", { url: request.url });

  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef } = parsedParams.data;

  const project = await prisma.project.findFirst({
    where: {
      externalRef: projectRef,
      organization: {
        deletedAt: null,
        members: {
          some: {
            userId: authenticationResult.userId,
          },
        },
      },
      deletedAt: null,
    },
    include: {
      organization: true,
    },
  });

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  if (project.version !== "V3") {
    return json({ error: "Project found but was not a v3 project" }, { status: 404 });
  }

  const result: GetProjectResponseBody = {
    id: project.id,
    externalRef: project.externalRef,
    name: project.name,
    slug: project.slug,
    createdAt: project.createdAt,
    organization: {
      id: project.organization.id,
      title: project.organization.title,
      slug: project.organization.slug,
      createdAt: project.organization.createdAt,
    },
  };

  return json(result);
}
