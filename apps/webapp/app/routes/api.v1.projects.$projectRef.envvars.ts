import { type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { resolveVariablesForEnvironment } from "~/v3/environmentVariables/environmentVariablesRepository.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  // Reading env vars requires the read:envvars scope (root keys authorize
  // everything).
  const authResult = await authenticateApiKeyWithScope(request, {
    action: "read",
    resource: { type: "envvars" },
  });
  if (!authResult.ok) {
    return json({ error: authResult.error }, { status: authResult.status });
  }
  const authenticationResult = authResult.authentication;

  const { projectRef } = parsedParams.data;

  const project = await prisma.project.findFirst({
    where: {
      externalRef: projectRef,
      environments: {
        some: {
          id: authenticationResult.environment.id,
        },
      },
    },
  });

  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const envVarEnvironment = await prisma.runtimeEnvironment.findFirst({
    where: {
      id: authenticationResult.environment.id,
    },
    include: {
      parentEnvironment: true,
      // Feeds resolveProdApiOrigin; only loaded when internal-origin routing is possible.
      ...(env.INTERNAL_API_ORIGIN ? { organization: { select: { featureFlags: true } } } : {}),
    },
  });

  if (!envVarEnvironment) {
    return json({ error: "Environment not found" }, { status: 404 });
  }

  const variables = await resolveVariablesForEnvironment(
    envVarEnvironment,
    envVarEnvironment.parentEnvironment ?? undefined
  );

  return json({
    variables: variables.reduce((acc: Record<string, string>, variable) => {
      acc[variable.key] = variable.value;
      return acc;
    }, {}),
  });
}
