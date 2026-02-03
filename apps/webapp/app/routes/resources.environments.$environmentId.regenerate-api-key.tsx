import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { regenerateApiKey } from "~/models/api-key.server";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import { jsonWithErrorMessage, jsonWithSuccessMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  environmentId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const userId = await requireUserId(request);

  const { environmentId } = ParamsSchema.parse(params);

  try {
    const updatedEnvironment = await regenerateApiKey({ userId, environmentId });

    // Sync the regenerated API key to Vercel if integration exists
    await syncApiKeyToVercelInBackground(
      updatedEnvironment.projectId,
      updatedEnvironment.type as "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT",
      updatedEnvironment.apiKey
    );

    return jsonWithSuccessMessage(
      { ok: true },
      request,
      `API keys regenerated for ${environmentFullTitle(updatedEnvironment)} environment`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    return jsonWithErrorMessage(
      { ok: false },
      request,
      `API keys could not be regenerated: ${message}`
    );
  }
}

/**
 * Sync the API key to Vercel.
 * Errors are logged but won't fail the API key regeneration.
 */
async function syncApiKeyToVercelInBackground(
  projectId: string,
  environmentType: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT",
  apiKey: string
): Promise<void> {
  try {
    const result = await VercelIntegrationRepository.syncSingleApiKeyToVercel({
      projectId,
      environmentType,
      apiKey,
    });
  } catch (error) {
    // Log but don't throw - we don't want to fail the main operation
    logger.warn("Error syncing regenerated API key to Vercel", {
      projectId,
      environmentType,
      error,
    });
  }
}
