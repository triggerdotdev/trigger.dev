import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import {
  CreateProjectRequestBody,
  GetProjectResponseBody,
  GetProjectsResponseBody,
  tryCatch,
} from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createProject } from "~/models/project.server";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { isCuid } from "cuid";

const ParamsSchema = z.object({
  orgParam: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  logger.info("get projects", { url: request.url });

  try {
    const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const { orgParam } = ParamsSchema.parse(params);

    const projects = await prisma.project.findMany({
      where: {
        organization: {
          ...orgParamWhereClause(orgParam),
          deletedAt: null,
          members: {
            some: {
              userId: authenticationResult.userId,
            },
          },
        },
        version: "V3",
        deletedAt: null,
      },
      include: {
        organization: true,
      },
    });

    if (!projects) {
      return json({ error: "Projects not found" }, { status: 404 });
    }

    const result: GetProjectsResponseBody = projects.map((project) => ({
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
    }));

    return json(result);
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to list org projects", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function action({ request, params }: ActionFunctionArgs) {
  try {
    const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const { orgParam } = ParamsSchema.parse(params);

    const organization = await prisma.organization.findFirst({
      where: {
        ...orgParamWhereClause(orgParam),
        deletedAt: null,
        members: {
          some: {
            userId: authenticationResult.userId,
          },
        },
      },
    });

    if (!organization) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    const body = await request.json();
    const parsedBody = CreateProjectRequestBody.safeParse(body);

    if (!parsedBody.success) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const [error, project] = await tryCatch(
      createProject({
        organizationSlug: organization.slug,
        name: parsedBody.data.name,
        userId: authenticationResult.userId,
        version: "v3",
      })
    );

    if (error) {
      logger.error("Failed to create project", { error });
      return json({ error: "Failed to create project" }, { status: 400 });
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
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to create org project", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}

function orgParamWhereClause(orgParam: string) {
  // If the orgParam is an ID, or if it's a slug
  // IDs are cuid
  if (isCuid(orgParam)) {
    return {
      id: orgParam,
    };
  }

  return {
    slug: orgParam,
  };
}
