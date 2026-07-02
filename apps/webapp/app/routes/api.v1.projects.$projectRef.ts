import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { GetProjectResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { DeleteProjectService } from "~/services/deleteProject.server";
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

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "DELETE") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef } = parsedParams.data;

  // Resolve id from ref scoped to membership; DeleteProjectService enforces
  // membership again, but this maps a 404 (not member / unknown ref) cleanly.
  const project = await prisma.project.findFirst({
    where: {
      externalRef: projectRef,
      organization: { deletedAt: null, members: { some: { userId: authenticationResult.userId } } },
      deletedAt: null,
    },
    select: { id: true },
  });

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  try {
    await new DeleteProjectService().call({
      projectId: project.id,
      userId: authenticationResult.userId,
    });

    return json({ id: project.id });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to delete project", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
