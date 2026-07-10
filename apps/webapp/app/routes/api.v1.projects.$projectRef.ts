import { json } from "@remix-run/server-runtime";
import type { GetProjectResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { DeleteProjectService } from "~/services/deleteProject.server";
import { logger } from "~/services/logger.server";
import {
  createActionPATApiRoute,
  createLoaderPATApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { ProjectSettingsService } from "~/services/projectSettings.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export const loader = createLoaderPATApiRoute(
  {
    params: ParamsSchema,
  },
  async ({ params, authentication }) => {
    const project = await prisma.project.findFirst({
      where: {
        externalRef: params.projectRef,
        organization: {
          deletedAt: null,
          members: {
            some: {
              userId: authentication.userId,
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
);

const RenameProjectRequestBody = z.object({
  name: z.string().trim().min(1).max(255),
});

// Multi-method (PATCH rename / DELETE): declare both so other verbs 405, and
// the handler branches. No builder body schema — DELETE has none, so the PATCH
// branch parses its own body.
export const action = createActionPATApiRoute(
  {
    method: ["PATCH", "DELETE"],
    params: ParamsSchema,
    // Resolve the org (id only, no membership) so the plugin can compute the
    // caller's role floor for the manage:project gate below.
    context: async ({ projectRef }) => {
      const project = await prisma.project.findFirst({
        where: { externalRef: projectRef, deletedAt: null },
        select: { organizationId: true },
      });
      return project ? { organizationId: project.organizationId } : {};
    },
    authorization: { action: "manage", resource: () => ({ type: "project" }) },
  },
  async ({ request, params, authentication }) => {
    // Resolve id from ref scoped to membership; the services enforce membership
    // again, but this maps a 404 (not member / unknown ref) cleanly.
    const project = await prisma.project.findFirst({
      where: {
        externalRef: params.projectRef,
        organization: {
          deletedAt: null,
          members: { some: { userId: authentication.userId } },
        },
        deletedAt: null,
      },
      select: { id: true, organizationId: true },
    });

    if (!project) {
      return json({ error: "Project not found" }, { status: 404 });
    }

    const method = request.method.toUpperCase();

    if (method === "DELETE") {
      await new DeleteProjectService().call({
        projectId: project.id,
        userId: authentication.userId,
      });

      return json({ id: project.id });
    }

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const body = RenameProjectRequestBody.safeParse(rawBody);

    if (!body.success) {
      return json({ error: "Invalid request body" }, { status: 400 });
    }

    const result = await new ProjectSettingsService().renameProject(project.id, body.data.name);

    if (result.isErr()) {
      logger.error("Failed to rename project", { error: result.error });
      return json({ error: "Failed to rename project" }, { status: 400 });
    }

    return json({ id: result.value.id, name: result.value.name });
  }
);
