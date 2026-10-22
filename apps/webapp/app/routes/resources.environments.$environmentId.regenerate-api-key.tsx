import { z } from "zod";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { $replica } from "~/db.server";
import { regenerateApiKey } from "~/models/api-key.server";
import { jsonWithErrorMessage, jsonWithSuccessMessage } from "~/models/message.server";
import { VercelIntegrationRepository } from "~/models/vercelIntegration.server";
import { logger } from "~/services/logger.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";

const ParamsSchema = z.object({
  environmentId: z.string(),
});

export const action = dashboardAction(
  {
    params: ParamsSchema,
    context: async (params) => {
      const environment = await $replica.runtimeEnvironment.findFirst({
        where: { id: params.environmentId },
        select: { organizationId: true },
      });
      return environment ? { organizationId: environment.organizationId } : {};
    },
    // Env-tier write:apiKeys is enforced in the handler — the target
    // environment's tier isn't known until we resolve it from the id.
  },
  async ({ request, params, user, ability }) => {
    if (request.method.toUpperCase() !== "POST") {
      throw new Response("Method Not Allowed", { status: 405 });
    }

    const { environmentId } = params;

    const environment = await $replica.runtimeEnvironment.findFirst({
      where: { id: environmentId },
      select: { type: true },
    });
    if (!environment) {
      return jsonWithErrorMessage({ ok: false }, request, "Environment not found");
    }

    // Gate the regenerate even on a direct POST: a role that can't write
    // this tier's API keys can't rotate them. The disabled UI control is
    // not the boundary; this check is.
    if (!ability.can("write", { type: "apiKeys", envType: environment.type })) {
      return jsonWithErrorMessage(
        { ok: false },
        request,
        "You don't have permission to regenerate API keys for this environment."
      );
    }

    const formData = await request.formData();
    const syncToVercel = formData.get("syncToVercel") === "on";

    try {
      const updatedEnvironment = await regenerateApiKey({ userId: user.id, environmentId });

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
);

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
