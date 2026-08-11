import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateRequestWithScopedApiKey } from "~/services/apiAuth.server";
import { ArchiveBranchService } from "~/services/archiveBranch.server";
import { logger } from "~/services/logger.server";
import { toBranchableEnvironmentType } from "~/utils/branchableEnvironment";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

const BodySchema = z.object({
  // Defaults to "preview" so existing CLIs that don't send `env` keep working.
  env: z.enum(["preview", "development"]).default("preview"),
  branch: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  logger.info("Archive branch", { url: request.url, params });

  const authentication = await authenticateRequestWithScopedApiKey(request, {
    personalAccessToken: true,
    organizationAccessToken: true,
    apiKey: {
      action: "write",
      resource: { type: "branches" },
      allowPreviewParent: true,
    },
  });

  if (!authentication.ok) {
    return json({ error: authentication.error }, { status: authentication.status });
  }
  const authenticationResult = authentication.authentication;

  const apiKeyEnvironment =
    authenticationResult.type === "apiKey" && authenticationResult.result.ok
      ? authenticationResult.result.environment
      : undefined;

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef } = parsedParams.data;

  const [error, body] = await tryCatch(request.json());
  if (error) {
    return json({ error: error.message }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: parsed.error.message }, { status: 400 });
  }

  const { env, branch } = parsed.data;

  // API keys can only archive Preview branches
  if (
    authenticationResult.type === "apiKey" &&
    (!apiKeyEnvironment ||
      apiKeyEnvironment.type !== "PREVIEW" ||
      apiKeyEnvironment.parentEnvironmentId !== null ||
      env !== "preview")
  ) {
    return json(
      { error: "API keys must belong to the parent Preview environment." },
      { status: 403 }
    );
  }

  // API keys can only act on their own project
  if (
    authenticationResult.type === "apiKey" &&
    apiKeyEnvironment?.project.externalRef !== projectRef
  ) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const environmentType = toBranchableEnvironmentType(env);

  const organizationFilter =
    authenticationResult.type === "organizationAccessToken"
      ? { id: authenticationResult.result.organizationId }
      : authenticationResult.type === "apiKey"
        ? { id: apiKeyEnvironment!.organizationId }
        : {
            members: {
              some: {
                userId: authenticationResult.result.userId,
              },
            },
          };

  const environments = await prisma.runtimeEnvironment.findMany({
    select: {
      id: true,
      archivedAt: true,
    },
    where: {
      organization: organizationFilter,
      // Dev branches are per-org-member: only the owner may archive their own.
      ...(authenticationResult.type === "personalAccessToken" && environmentType === "DEVELOPMENT"
        ? { orgMember: { userId: authenticationResult.result.userId } }
        : {}),
      project: {
        externalRef: projectRef,
      },
      type: environmentType,
      branchName: branch,
    },
  });

  if (environments.length === 0) {
    return json({ error: "Branch not found" }, { status: 404 });
  }

  const activeEnvironments = environments.filter((env) => env.archivedAt === null);

  if (
    authenticationResult.type !== "personalAccessToken" &&
    environmentType === "DEVELOPMENT" &&
    activeEnvironments.length > 1
  ) {
    return json(
      {
        error:
          "Branch name is ambiguous for development environments. Use a personal access token scoped to the branch owner.",
      },
      { status: 409 }
    );
  }

  const environment = activeEnvironments[0];

  if (!environment) {
    return json({ error: "Branch already archived" }, { status: 400 });
  }

  let orgFilter:
    | { type: "userMembership"; userId: string }
    | { type: "orgId"; organizationId: string };
  if (authenticationResult.type === "personalAccessToken") {
    orgFilter = { type: "userMembership", userId: authenticationResult.result.userId };
  } else if (authenticationResult.type === "organizationAccessToken") {
    orgFilter = { type: "orgId", organizationId: authenticationResult.result.organizationId };
  } else {
    orgFilter = { type: "orgId", organizationId: apiKeyEnvironment!.organizationId };
  }

  const service = new ArchiveBranchService();
  const result = await service.call(orgFilter, {
    environmentId: environment.id,
  });

  if (result.success) {
    return json(result);
  } else {
    return json(result, { status: 400 });
  }
}
