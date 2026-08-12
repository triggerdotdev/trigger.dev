import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch, UpsertBranchRequestBody } from "@trigger.dev/core/v3";
import { DEFAULT_DEV_BRANCH, isDefaultDevBranch } from "@trigger.dev/core/v3/utils/gitBranch";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateRequestWithScopedApiKey } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { UpsertBranchService } from "~/services/upsertBranch.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

type ParamsSchema = z.infer<typeof ParamsSchema>;

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  logger.info("project upsert branch", { url: request.url });

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

  let project: { id: string } | null | undefined;
  if (authenticationResult.type === "apiKey") {
    project =
      apiKeyEnvironment?.project.externalRef === projectRef
        ? { id: apiKeyEnvironment.project.id }
        : undefined;
  } else {
    project = await prisma.project.findFirst({
      select: {
        id: true,
      },
      where: {
        externalRef: projectRef,
        organization:
          authenticationResult.type === "organizationAccessToken"
            ? { id: authenticationResult.result.organizationId }
            : {
                members: {
                  some: {
                    userId: authenticationResult.result.userId,
                  },
                },
              },
      },
    });
  }
  if (!project) {
    return json({ error: "Project not found" }, { status: 404 });
  }

  const [error, body] = await tryCatch(request.json());
  if (error) {
    return json({ error: error.message }, { status: 400 });
  }

  const parsed = UpsertBranchRequestBody.safeParse(body);
  if (!parsed.success) {
    return json({ error: parsed.error.message }, { status: 400 });
  }

  const { branch, env, git } = parsed.data;

  if (env === "development" && authenticationResult.type !== "personalAccessToken") {
    return json(
      {
        error:
          authenticationResult.type === "apiKey"
            ? "API keys can only create Preview branches."
            : "Cannot create dev branches with organization access tokens.",
      },
      { status: 400 }
    );
  }

  if (
    authenticationResult.type === "apiKey" &&
    (!apiKeyEnvironment ||
      apiKeyEnvironment.type !== "PREVIEW" ||
      apiKeyEnvironment.parentEnvironmentId !== null)
  ) {
    return json(
      { error: "API keys must belong to the parent Preview environment." },
      { status: 403 }
    );
  }

  if (env === "development" && isDefaultDevBranch(branch)) {
    return json(
      { error: `Cannot create dev branch with name '${DEFAULT_DEV_BRANCH}'.` },
      { status: 400 }
    );
  }

  let orgFilter:
    | { type: "userMembership"; userId: string }
    | { type: "orgId"; organizationId: string };
  if (authenticationResult.type === "personalAccessToken") {
    orgFilter = { type: "userMembership", userId: authenticationResult.result.userId };
  } else if (authenticationResult.type === "organizationAccessToken") {
    orgFilter = { type: "orgId", organizationId: authenticationResult.result.organizationId };
  } else {
    if (!apiKeyEnvironment) {
      return json({ error: "Invalid API key" }, { status: 401 });
    }
    orgFilter = { type: "orgId", organizationId: apiKeyEnvironment.organizationId };
  }

  const service = new UpsertBranchService();
  const result = await service.call(orgFilter, {
    env,
    branchName: branch,
    projectId: project.id,
    git,
  });

  if (!result.success) {
    return json({ error: result.error }, { status: 400 });
  }

  return json({ id: result.branch.id });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef } = parsedParams.data;

  const project = await prisma.project.findFirst({
    select: {
      id: true,
    },
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

  const previewEnvironment = await prisma.runtimeEnvironment.findFirst({
    select: {
      id: true,
    },
    where: {
      projectId: project.id,
      slug: "preview",
    },
  });

  if (!previewEnvironment) {
    return json(
      { error: "You don't have preview branches setup. Go to the dashboard to enable them." },
      { status: 400 }
    );
  }

  const branches = await prisma.runtimeEnvironment.findMany({
    where: {
      projectId: project.id,
      parentEnvironmentId: previewEnvironment.id,
      archivedAt: null,
    },
    select: {
      id: true,
      branchName: true,
      createdAt: true,
      updatedAt: true,
      git: true,
      paused: true,
    },
  });

  return json({
    branches: branches.map((branch) => ({
      id: branch.id,
      name: branch.branchName ?? "main",
      createdAt: branch.createdAt,
      updatedAt: branch.updatedAt,
      git: branch.git ?? undefined,
      isPaused: branch.paused,
    })),
  });
}
