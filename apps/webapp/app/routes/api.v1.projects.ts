import { json } from "@remix-run/server-runtime";
import type { GetProjectsResponseBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

// Identity-only: lists projects across the caller's orgs, so no authorization gate. An
// org-scoped user-actor token narrows that to its own organization, membership still required.
export const loader = createLoaderPATApiRoute(
  {
    identityOnly: true,
    searchParams: z.object({ organizationId: z.string().optional() }),
  },
  async ({ authentication, searchParams }) => {
    const claimedOrganizationId = authentication.userActor?.organizationId;
    const requestedOrganizationId = searchParams.organizationId;

    if (
      claimedOrganizationId &&
      requestedOrganizationId &&
      requestedOrganizationId !== claimedOrganizationId
    ) {
      return json(
        {
          error: "This token isn't scoped to that organization.",
          code: "forbidden_environment",
        },
        { status: 403 }
      );
    }

    const projects = await prisma.project.findMany({
      where: {
        ...(claimedOrganizationId ? { organizationId: claimedOrganizationId } : {}),
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
  }
);
