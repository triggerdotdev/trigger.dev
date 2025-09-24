import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { CancelDeploymentRequestBody, tryCatch } from "@trigger.dev/core/v3";
import { z } from "zod";
import { authenticateRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { DeploymentService } from "~/v3/services/deployment.server";

const ParamsSchema = z.object({
  deploymentId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return json({ error: "Method Not Allowed" }, { status: 405 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  const authenticationResult = await authenticateRequest(request, {
    apiKey: true,
    organizationAccessToken: false,
    personalAccessToken: false,
  });

  if (!authenticationResult || !authenticationResult.result.ok) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const { environment: authenticatedEnv } = authenticationResult.result;
  const { deploymentId } = parsedParams.data;

  const [, rawBody] = await tryCatch(request.json());
  const body = CancelDeploymentRequestBody.safeParse(rawBody ?? {});

  if (!body.success) {
    return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
  }

  const deploymentService = new DeploymentService();

  return await deploymentService
    .cancelDeployment(authenticatedEnv, deploymentId, {
      canceledReason: body.data.reason,
    })
    .match(
      () => {
        return new Response(null, { status: 204 });
      },
      (error) => {
        switch (error.type) {
          case "deployment_not_found":
            return json({ error: "Deployment not found" }, { status: 404 });
          case "failed_to_delete_deployment_timeout":
            return new Response(null, { status: 204 }); // not a critical error, ignore
          case "deployment_cannot_be_cancelled":
            return json(
              { error: "Deployment is already in a final state and cannot be canceled" },
              { status: 409 }
            );
          case "other":
          default:
            error.type satisfies "other";
            return json({ error: "Internal server error" }, { status: 500 });
        }
      }
    );
}
