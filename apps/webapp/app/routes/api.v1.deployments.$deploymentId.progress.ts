import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { ProgressDeploymentRequestBody } from "@trigger.dev/core/v3";
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

  const rawBody = await request.json();
  const body = ProgressDeploymentRequestBody.safeParse(rawBody);

  if (!body.success) {
    return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
  }

  const deploymentService = new DeploymentService();

  return await deploymentService
    .progressDeployment(authenticatedEnv, deploymentId, {
      contentHash: body.data.contentHash,
      git: body.data.gitMeta,
      runtime: body.data.runtime,
    })
    .match(
      () => {
        return new Response(null, { status: 204 });
      },
      (error) => {
        switch (error.type) {
          case "failed_to_extend_deployment_timeout":
            return new Response(null, { status: 204 }); // ignore these errors for now
          case "deployment_not_found":
            return json({ error: "Deployment not found" }, { status: 404 });
          case "deployment_cannot_be_progressed":
            return json(
              { error: "Deployment is not in a progressable state (PENDING or INSTALLING)" },
              { status: 409 }
            );
          case "failed_to_create_remote_build":
            return json({ error: "Failed to create remote build" }, { status: 500 });
          case "other":
          default:
            error.type satisfies "other";
            return json({ error: "Internal server error" }, { status: 500 });
        }
      }
    );
}
