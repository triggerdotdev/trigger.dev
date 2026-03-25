import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type GetProjectEnvResponse } from "@trigger.dev/core/v3";
import { z } from "zod";
import { env as processEnv } from "~/env.server";
import {
  authenticatedEnvironmentForAuthentication,
  authenticateRequest,
  branchNameFromRequest,
} from "~/services/apiAuth.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

type ParamsSchema = z.infer<typeof ParamsSchema>;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef, env } = parsedParams.data;

  const authenticationResult = await authenticateRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const environment = await authenticatedEnvironmentForAuthentication(
    authenticationResult,
    projectRef,
    env,
    branchNameFromRequest(request)
  );

  const result: GetProjectEnvResponse = {
    apiKey: environment.apiKey,
    name: environment.project.name,
    apiUrl: processEnv.API_ORIGIN ?? processEnv.APP_ORIGIN,
    projectId: environment.project.id,
  };

  return json(result);
}
