import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { z } from "zod";
import { devPresence } from "~/presenters/v3/DevPresence.server";
import {
  authenticatedEnvironmentForAuthentication,
  authenticateRequest,
} from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const authenticationResult = await authenticateRequest(request, {
      personalAccessToken: true,
      organizationAccessToken: true,
      apiKey: false,
    });

    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const parsedParams = ParamsSchema.safeParse(params);

    if (!parsedParams.success) {
      return json({ error: "Invalid Params" }, { status: 400 });
    }

    const { projectRef } = parsedParams.data;

    const runtimeEnv = await authenticatedEnvironmentForAuthentication(
      authenticationResult,
      projectRef,
      "dev"
    );

    const isConnected = await devPresence.isConnected(runtimeEnv.id);

    return json({ isConnected });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to load dev status", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
