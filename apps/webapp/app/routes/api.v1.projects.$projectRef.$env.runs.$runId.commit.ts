import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import {
  authenticatedEnvironmentForAuthentication,
  type AuthenticatedEnvironment,
} from "~/services/apiAuth.server";
import { resolveRunCommit } from "~/services/dashboardAgent.server";
import { authorizePatEnvironmentAccess } from "~/services/environmentVariableApiAccess.server";
import { logger } from "~/services/logger.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

/** The commit a run's deployed version came from, plus that deployment's git metadata. */

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
  runId: z.string(),
});

type GitMetaBlob = {
  source?: string;
  commitAuthorName?: string;
  commitMessage?: string;
  commitRef?: string;
  remoteUrl?: string;
  ghUsername?: string;
  pullRequestNumber?: number;
  pullRequestTitle?: string;
  pullRequestState?: string;
};

export async function loader({ request, params }: LoaderFunctionArgs) {
  // Hoisted so a failure below can name the tenant it happened to.
  let runtimeEnv: AuthenticatedEnvironment | undefined;

  try {
    const authentication = await authenticateUatOrApiRequest(request);
    if (!authentication) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) return json({ error: "Invalid Params" }, { status: 400 });
    const { projectRef, env, runId } = parsed.data;

    const triggerBranch = request.headers.get("x-trigger-branch") ?? undefined;
    // An org-claim token resolves a run in any project of its org, so the agent can follow a run
    // it found in a sibling project. Membership is `findProjectByRef` inside the resolve.
    runtimeEnv = await authenticatedEnvironmentForAuthentication(
      authentication.authenticationResult,
      projectRef,
      env,
      triggerBranch,
      { organizationScoped: true }
    );

    // The answer is a deployment's git metadata, so it's gated like the deployments list.
    const denied = await authorizePatEnvironmentAccess({
      request,
      authType: authentication.authenticationResult.type,
      organizationId: runtimeEnv.organizationId,
      projectId: runtimeEnv.project.id,
      envType: runtimeEnv.type,
      resource: "deployments",
      action: "read",
    });
    if (denied) return denied;

    const commit = await resolveRunCommit(runtimeEnv.id, runId);
    if (!commit) {
      return json(
        { error: "That run has no deployed commit (it may be a dev run)." },
        { status: 404 }
      );
    }

    const deployment = await $replica.workerDeployment.findFirst({
      where: { environmentId: runtimeEnv.id, version: commit.version },
      select: { git: true, shortCode: true, deployedAt: true },
    });

    const git = (deployment?.git ?? undefined) as GitMetaBlob | undefined;

    return json({
      runId,
      version: commit.version,
      sha: commit.sha,
      dirty: commit.dirty,
      shortCode: deployment?.shortCode,
      deployedAt: deployment?.deployedAt ?? undefined,
      git: git
        ? {
            source: git.source,
            commitMessage: git.commitMessage,
            commitAuthorName: git.commitAuthorName,
            commitRef: git.commitRef,
            remoteUrl: git.remoteUrl,
            ghUsername: git.ghUsername,
            pullRequestNumber: git.pullRequestNumber,
            pullRequestTitle: git.pullRequestTitle,
            pullRequestState: git.pullRequestState,
          }
        : undefined,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to resolve run commit", {
      error,
      environmentId: runtimeEnv?.id,
      projectId: runtimeEnv?.project.id,
      organizationId: runtimeEnv?.organizationId,
    });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
