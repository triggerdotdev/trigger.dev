import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { GetProjectResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { DeleteProjectService } from "~/services/deleteProject.server";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { ProjectSettingsService } from "~/services/projectSettings.server";

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
      defaultWorkerGroup: { select: { name: true } },
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
    defaultRegion: project.defaultWorkerGroup?.name ?? null,
    organization: {
      id: project.organization.id,
      title: project.organization.title,
      slug: project.organization.slug,
      createdAt: project.organization.createdAt,
    },
  };

  return json(result);
}

const RenameProjectRequestBody = z.object({
  name: z.string().min(1),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const method = request.method.toUpperCase();
  if (method !== "DELETE" && method !== "PATCH") {
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

  // Resolve id from ref scoped to membership; the services enforce membership
  // again, but this maps a 404 (not member / unknown ref) cleanly.
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
    if (method === "DELETE") {
      await new DeleteProjectService().call({
        projectId: project.id,
        userId: authenticationResult.userId,
      });

      return json({ id: project.id });
    }

    const body = RenameProjectRequestBody.safeParse(await request.json());

    if (!body.success) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const result = await new ProjectSettingsService().renameProject(project.id, body.data.name);

    if (result.isErr()) {
      logger.error("Failed to rename project", { error: result.error });
      return json({ error: "Failed to rename project" }, { status: 400 });
    }

    return json({ id: result.value.id, name: result.value.name });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to update project", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
