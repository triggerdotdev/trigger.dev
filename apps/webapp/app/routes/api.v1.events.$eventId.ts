import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  eventId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    corsStrategy: "all",
    findResource: async (params, auth) => {
      return prisma.eventDefinition.findFirst({
        where: {
          slug: params.eventId,
          projectId: auth.environment.projectId,
        },
        include: {
          subscriptions: {
            where: {
              environmentId: auth.environment.id,
            },
            select: {
              taskSlug: true,
              enabled: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });
    },
    authorization: {
      action: "read",
      resource: (resource) => ({ tasks: resource.slug }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ resource }) => {
    return json({
      id: resource.id,
      slug: resource.slug,
      version: resource.version,
      description: resource.description,
      schema: resource.schema,
      deprecatedAt: resource.deprecatedAt,
      deprecatedMessage: resource.deprecatedMessage,
      compatibleVersions: resource.compatibleVersions,
      subscribers: resource.subscriptions.map((s) => ({
        taskSlug: s.taskSlug,
        enabled: s.enabled,
      })),
      createdAt: resource.createdAt,
      updatedAt: resource.updatedAt,
    });
  }
);
