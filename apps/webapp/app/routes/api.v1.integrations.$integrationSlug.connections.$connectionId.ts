import { LoaderArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { resolveApiConnection } from "~/models/runConnection.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { apiCors } from "~/utils/apiCors";

const ParamsSchema = z.object({
  integrationSlug: z.string(),
  connectionId: z.string(),
});

export async function loader({ request, params }: LoaderArgs) {
  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  if (authenticationResult.type !== "PRIVATE") {
    return json({ error: "Only private API keys can access this endpoint" }, { status: 403 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return apiCors(request, json({ error: parsedParams.error.message }, { status: 400 }));
  }

  const connection = await prisma.integrationConnection.findFirst({
    where: {
      id: parsedParams.data.connectionId,
      integration: {
        slug: parsedParams.data.integrationSlug,
        organization: authenticatedEnv.organization,
      },
    },
    include: {
      integration: {
        include: {
          authMethod: true,
        },
      },
      dataReference: true,
    },
  });

  if (!connection) {
    return apiCors(request, json({ error: "Connection not found" }, { status: 404 }));
  }

  const auth = await resolveApiConnection(connection);

  return json({
    id: connection.id,
    type: connection.connectionType,
    externalAccountId: connection.externalAccountId,
    expiresAt: connection.expiresAt,
    auth,
    integration: {
      id: connection.integration.id,
      slug: connection.integration.slug,
      title: connection.integration.title,
      description: connection.integration.description,
      authSource: connection.integration.authSource,
      authMethod: connection.integration.authMethod
        ? {
            id: connection.integration.authMethod.id,
            key: connection.integration.authMethod.key,
            name: connection.integration.authMethod.name,
            description: connection.integration.authMethod.description,
            type: connection.integration.authMethod.type,
          }
        : null,
    },
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  });
}
