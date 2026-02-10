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

  const formData = await request.formData();
  const syncToVercel = formData.get("syncToVercel") === "on";

  try {
    const updatedEnvironment = await regenerateApiKey({ userId, environmentId });

    // Sync the regenerated API key to Vercel only when requested and not for DEVELOPMENT
    if (syncToVercel && updatedEnvironment.type !== "DEVELOPMENT") {
      await syncApiKeyToVercel(
        updatedEnvironment.projectId,
        updatedEnvironment.type as "PRODUCTION" | "STAGING" | "PREVIEW",
        updatedEnvironment.apiKey
      );
    }

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
async function syncApiKeyToVercel(
  projectId: string,
  environmentType: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT",
  apiKey: string
): Promise<void> {
  const result = await VercelIntegrationRepository.syncSingleApiKeyToVercel({
    projectId,
    environmentType,
    apiKey,
  });

  if (result.isErr()) {
    logger.warn("syncSingleApiKeyToVercel returned failure", {
      projectId,
      environmentType,
      error: result.error.message,
    });
  }
}
