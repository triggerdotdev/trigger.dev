import { json } from "@remix-run/server-runtime";
import type { GetProjectsResponseBody } from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

// Identity-only: lists projects across the caller's orgs, so no authorization gate.
export const loader = createLoaderPATApiRoute({}, async ({ authentication }) => {
  const projects = await prisma.project.findMany({
    where: {
      organization: {
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
});
