import { json } from "@remix-run/server-runtime";
import type { GetProjectResponseBody, GetProjectsResponseBody } from "@trigger.dev/core/v3";
import { CreateProjectRequestBody, tryCatch } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createProject } from "~/models/project.server";
import { logger } from "~/services/logger.server";
import {
  createActionPATApiRoute,
  createLoaderPATApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import cuid from "cuid";
const { isCuid } = cuid;

const ParamsSchema = z.object({
  orgParam: z.string(),
});

export const loader = createLoaderPATApiRoute(
  {
    params: ParamsSchema,
  },
  async ({ params, authentication }) => {
    const projects = await prisma.project.findMany({
      where: {
        organization: {
          ...orgParamWhereClause(params.orgParam),
          deletedAt: null,
          members: {
            some: {
              userId: authentication.userId,
            },
          },
        },
        version: "V3",
        deletedAt: null,
      },
      include: {
        organization: true,
        defaultWorkerGroup: { select: { name: true } },
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
      defaultRegion: project.defaultWorkerGroup?.name ?? null,
      organization: {
        id: project.organization.id,
        title: project.organization.title,
        slug: project.organization.slug,
        createdAt: project.organization.createdAt,
      },
    }));

    return json(result);
  }
);

export const action = createActionPATApiRoute(
  {
    method: "POST",
    params: ParamsSchema,
    body: CreateProjectRequestBody,
    // Resolve the org (id only, no membership) so the plugin can compute the
    // caller's role floor.
    context: async ({ orgParam }) => {
      const org = await prisma.organization.findFirst({
        where: { ...orgParamWhereClause(orgParam), deletedAt: null },
        select: { id: true },
      });
      return org ? { organizationId: org.id } : {};
    },
    // No authorization gate: creating a project is a member-level action
    // (mirrors the dashboard), not an owner-only one like rename/delete.
  },
  async ({ params, body, authentication }) => {
    const organization = await prisma.organization.findFirst({
      where: {
        ...orgParamWhereClause(params.orgParam),
        deletedAt: null,
        members: {
          some: {
            userId: authentication.userId,
          },
        },
      },
    });

    if (!organization) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    const [error, project] = await tryCatch(
      createProject({
        organizationSlug: organization.slug,
        name: body.name,
        userId: authentication.userId,
        version: "v3",
      })
    );

    if (error) {
      logger.error("Failed to create project", { error });
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 400 });
      }
      return json({ error: "Failed to create project" }, { status: 400 });
    }

    // Derive from the stored id rather than assuming new projects are unset,
    // so this stays correct if project creation ever inherits a default region.
    const defaultRegion = project.defaultWorkerGroupId
      ? ((
          await prisma.workerInstanceGroup.findFirst({
            where: { id: project.defaultWorkerGroupId },
            select: { name: true },
          })
        )?.name ?? null)
      : null;

    const result: GetProjectResponseBody = {
      id: project.id,
      externalRef: project.externalRef,
      name: project.name,
      slug: project.slug,
      createdAt: project.createdAt,
      defaultRegion,
      organization: {
        id: project.organization.id,
        title: project.organization.title,
        slug: project.organization.slug,
        createdAt: project.organization.createdAt,
      },
    };

    return json(result);
  }
);

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
