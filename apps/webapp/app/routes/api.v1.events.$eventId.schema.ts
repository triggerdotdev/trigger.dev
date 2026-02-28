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
        select: {
          slug: true,
          version: true,
          schema: true,
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
      slug: resource.slug,
      version: resource.version,
      schema: resource.schema,
    });
  }
);
