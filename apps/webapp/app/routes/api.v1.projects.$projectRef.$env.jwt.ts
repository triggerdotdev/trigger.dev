import { ActionFunctionArgs, json } from "@remix-run/node";
import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { getEnvironmentFromEnv } from "./api.v1.projects.$projectRef.$env";

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
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef, env } = parsedParams.data;

  const project = await prisma.project.findFirst({
    where: {
      externalRef: projectRef,
      organization: {
        members: {
          some: {
            userId: authenticationResult.userId,
          },
        },
      },
    },
  });

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const envResult = await getEnvironmentFromEnv({
    projectId: project.id,
    userId: authenticationResult.userId,
    env,
  });

  if (!envResult.success) {
    return json({ error: envResult.error }, { status: 404 });
  }

  const runtimeEnv = envResult.environment;

  const parsedBody = RequestBodySchema.safeParse(await request.json());

  if (!parsedBody.success) {
    return json(
      { error: "Invalid request body", issues: parsedBody.error.issues },
      { status: 400 }
    );
  }

  const triggerBranch = request.headers.get("x-trigger-branch") ?? undefined;

  let previewBranchEnvironmentId: string | undefined;

  if (triggerBranch) {
    const previewBranch = await prisma.runtimeEnvironment.findFirst({
      where: {
        projectId: project.id,
        branchName: triggerBranch,
        parentEnvironmentId: runtimeEnv.id,
        archivedAt: null,
      },
    });

    if (previewBranch) {
      previewBranchEnvironmentId = previewBranch.id;
    } else {
      return json({ error: `Preview branch ${triggerBranch} not found` }, { status: 404 });
    }
  }

  const claims = {
    sub: previewBranchEnvironmentId ?? runtimeEnv.id,
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
