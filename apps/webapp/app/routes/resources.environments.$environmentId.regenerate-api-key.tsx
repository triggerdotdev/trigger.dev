import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { regenerateApiKey } from "~/models/api-key.server";
import { requireUserId } from "~/services/session.server";
import { jsonWithErrorMessage, jsonWithSuccessMessage } from "~/models/message.server";
import { environmentTitle } from "~/components/environments/EnvironmentLabel";

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

    return jsonWithSuccessMessage(
      { ok: true },
      request,
      `API keys regenerated for ${environmentTitle(updatedEnvironment)} environment`
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
