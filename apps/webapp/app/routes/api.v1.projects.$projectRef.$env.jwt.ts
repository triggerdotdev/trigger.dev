import { type ActionFunctionArgs, json } from "@remix-run/node";
import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";
import { z } from "zod";
import {
  authenticatedEnvironmentForAuthentication,
  authenticateRequest,
} from "~/services/apiAuth.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

const RequestBodySchema = z.object({
  claims: z
    .object({
      scopes: z.array(z.string()).default([]),
    })
    .optional(),
  expirationTime: z.union([z.number(), z.string()]).optional(),
});

export async function action({ request, params }: ActionFunctionArgs) {
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

  const { projectRef, env } = parsedParams.data;
  const triggerBranch = request.headers.get("x-trigger-branch") ?? undefined;

  const runtimeEnv = await authenticatedEnvironmentForAuthentication(
    authenticationResult,
    projectRef,
    env,
    triggerBranch
  );

  const parsedBody = RequestBodySchema.safeParse(await request.json());

  if (!parsedBody.success) {
    return json(
      { error: "Invalid request body", issues: parsedBody.error.issues },
      { status: 400 }
    );
  }

  const claims = {
    sub: runtimeEnv.id,
    pub: true,
    ...parsedBody.data.claims,
  };

  const jwt = await internal_generateJWT({
    secretKey: runtimeEnv.apiKey,
    payload: claims,
    expirationTime: parsedBody.data.expirationTime ?? "1h",
  });

  return json({ token: jwt });
}
