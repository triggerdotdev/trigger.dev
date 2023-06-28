import type { LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { resolveApiConnection } from "~/models/runConnection.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  endpointSlug: z.string(),
  id: z.string(),
});

export async function loader({ request, params }: LoaderArgs) {
  logger.info("Fetching auth", { url: request.url });

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    logger.info("Invalid params", { params });

    return json({ error: "Invalid params" }, { status: 400 });
  }

  // Next authenticate the request
  const authenticatedEnv = await authenticateApiRequest(request);

  if (!authenticatedEnv) {
    logger.info("Invalid or missing api key", { url: request.url });

    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const integration = await prisma.integration.findUnique({
    where: {
      organizationId_slug: {
        organizationId: authenticatedEnv.organizationId,
        slug: parsedParams.data.id,
      },
    },
  });

  if (!integration) {
    return json({ error: "Integration not found" }, { status: 404 });
  }

  const connection = await prisma.integrationConnection.findFirst({
    where: {
      integrationId: integration.id,
      connectionType: "DEVELOPER",
    },
    include: {
      dataReference: true,
    },
  });

  if (!connection) {
    return json({ error: "Connection not found" }, { status: 404 });
  }

  const connectionAuth = await resolveApiConnection(connection);

  if (!connectionAuth) {
    return json({ error: "Access token not found" }, { status: 404 });
  }

  return json(connectionAuth);
}
