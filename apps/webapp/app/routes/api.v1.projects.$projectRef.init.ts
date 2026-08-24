import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { projectPubSub } from "~/v3/services/projectPubSub.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export const action = createActionPATApiRoute(
  {
    method: "POST",
    params: ParamsSchema,
    context: async ({ projectRef }) => {
      const project = await prisma.project.findFirst({
        where: { externalRef: projectRef, deletedAt: null },
        select: { organizationId: true },
      });
      return project ? { organizationId: project.organizationId } : {};
    },
    authorization: { action: "manage", resource: () => ({ type: "project" }) },
  },
  async ({ params, authentication }) => {
    const project = await prisma.project.findFirst({
      where: {
        externalRef: params.projectRef,
        organization: {
          deletedAt: null,
          members: { some: { userId: authentication.userId } },
        },
        deletedAt: null,
      },
      select: { id: true, initializedAt: true },
    });

    if (!project) {
      return json({ error: "Project not found" }, { status: 404 });
    }

    if (!project.initializedAt) {
      await prisma.project.updateMany({
        where: { id: project.id, initializedAt: null },
        data: { initializedAt: new Date() },
      });
    }

    const { initializedAt } =
      (await prisma.project.findFirst({
        where: { id: project.id },
        select: { initializedAt: true },
      })) ?? {};

    if (initializedAt) {
      try {
        await projectPubSub.publish(`project:${project.id}:initialized`, "PROJECT_INITIALIZED", {
          initializedAt,
        });
      } catch (error) {
        logger.debug("Failed to publish PROJECT_INITIALIZED", { error });
      }
    }

    return json({ id: project.id, initializedAt: initializedAt ?? null });
  }
);
