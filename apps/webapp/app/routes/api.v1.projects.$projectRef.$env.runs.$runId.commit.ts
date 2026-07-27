import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { authenticatedEnvironmentForAuthentication } from "~/services/apiAuth.server";
import { resolveRunCommit } from "~/services/dashboardAgent.server";
import { logger } from "~/services/logger.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

/**
 * The commit a run's deployed version came from, plus that deployment's git
 * metadata (commit message, branch, PR). Used by the dashboard agent's
 * `correlate_version` tool to answer "what code was this run actually running?"
 * and "which change introduced this?".
 *
 * Auth mirrors the repo-snapshot route: a delegated user-actor token
 * authenticates as its user (identity-only), as does a PAT.
 */

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
  runId: z.string(),
});

// Curated subset of WorkerDeployment.git (a GitMeta blob) — the fields that
// identify the change, not the whole payload.
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
  try {
    const authentication = await authenticateUatOrApiRequest(request);
    if (!authentication) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) return json({ error: "Invalid Params" }, { status: 400 });
    const { projectRef, env, runId } = parsed.data;

    const triggerBranch = request.headers.get("x-trigger-branch") ?? undefined;
    const runtimeEnv = await authenticatedEnvironmentForAuthentication(
      authentication.authenticationResult,
      projectRef,
      env,
      triggerBranch
    );

    const commit = await resolveRunCommit(runtimeEnv.id, runId);
    if (!commit) {
      return json(
        { error: "That run has no deployed commit (it may be a dev run)." },
        { status: 404 }
      );
    }

    // The version identifies the deployment within the environment; read its git
    // metadata for the human-facing detail (message, branch, PR).
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
    logger.error("Failed to resolve run commit", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
