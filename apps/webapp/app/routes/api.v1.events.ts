import { json } from "@remix-run/server-runtime";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { SchemaRegistryService } from "~/v3/services/events/schemaRegistry.server";

export const loader = createLoaderApiRoute(
  {
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: () => ({ tasks: "*" }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
    findResource: async () => 1 as const,
  },
  async ({ authentication }) => {
    const service = new SchemaRegistryService();

    const events = await service.listSchemas({
      projectId: authentication.environment.projectId,
      environmentId: authentication.environment.id,
    });

    return json({
      data: events.map((e) => ({
        id: e.id,
        slug: e.slug,
        version: e.version,
        description: e.description,
        hasSchema: e.schema !== null,
        deprecatedAt: e.deprecatedAt,
        subscriberCount: e.subscriberCount,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    });
  }
);
