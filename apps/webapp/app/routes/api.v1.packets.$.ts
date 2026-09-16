import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { generatePresignedUrl, jsonPacketPresignFailure } from "~/v3/objectStore.server";

const ParamsSchema = z.object({
  "*": z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "PUT") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.parse(params);
  const filename = parsedParams["*"];

  const signed = await generatePresignedUrl(
    authenticationResult.environment.project.externalRef,
    authenticationResult.environment.slug,
    filename,
    "PUT",
    { forceNoPrefix: true }
  );

  if (!signed.success) {
    return jsonPacketPresignFailure(signed);
  }

  // Caller can now use this URL to upload to that object.
  return json({ presignedUrl: signed.url });
}

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async () => 1, // This is a dummy function, we don't need to find a resource
  },
  async ({ params, authentication }) => {
    const filename = params["*"];

    // Public tokens should use /api/v1/runs/:runId/packets/:field, which authorizes
    // against the owning run. Access here is kept for clients on older SDKs.
    if (authentication.type === "PUBLIC_JWT") {
      logger.info("Legacy packet download with public token", {
        environmentId: authentication.environment.id,
        projectId: authentication.environment.projectId,
      });
    }

    const signed = await generatePresignedUrl(
      authentication.environment.project.externalRef,
      authentication.environment.slug,
      filename,
      "GET"
    );

    if (!signed.success) {
      return jsonPacketPresignFailure(signed);
    }

    // Caller can now use this URL to fetch that object.
    return json({ presignedUrl: signed.url });
  }
);
