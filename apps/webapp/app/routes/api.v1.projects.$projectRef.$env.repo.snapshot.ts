import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { isUserActorToken, verifyUserActorToken } from "@trigger.dev/rbac";
import { z } from "zod";
import { env as $env } from "~/env.server";
import {
  type AuthenticationResult,
  authenticatedEnvironmentForAuthentication,
  authenticateRequest,
} from "~/services/apiAuth.server";
import {
  resolveDashboardAgentRepoSnapshot,
  resolveRunCommit,
} from "~/services/dashboardAgent.server";
import { logger } from "~/services/logger.server";

// Resolve a signed source-archive pointer for the project's connected repo, used
// by the dashboard agent's code tools. With `?runId=run_...` it pins to the
// commit that run's deployed version came from (run-SHA pinning); without it,
// the tracked branch head. The GitHub token never leaves the server, only the
// short-lived signed URL is returned. Auth mirrors the worker-by-tag route: a
// delegated user-actor token authenticates as its user (identity-only).

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const bearer = request.headers
      .get("Authorization")
      ?.replace(/^Bearer /, "")
      .trim();
    let authenticationResult: AuthenticationResult | undefined;
    if (bearer && isUserActorToken(bearer)) {
      const claims = await verifyUserActorToken($env.SESSION_SECRET, bearer);
      if (!claims) return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
      authenticationResult = { type: "personalAccessToken", result: { userId: claims.userId } };
    } else {
      authenticationResult = await authenticateRequest(request, {
        personalAccessToken: true,
        organizationAccessToken: true,
        apiKey: false,
      });
    }
    if (!authenticationResult) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) return json({ error: "Invalid Params" }, { status: 400 });
    const { projectRef, env } = parsed.data;

    const triggerBranch = request.headers.get("x-trigger-branch") ?? undefined;
    const runtimeEnv = await authenticatedEnvironmentForAuthentication(
      authenticationResult,
      projectRef,
      env,
      triggerBranch
    );

    const runId = new URL(request.url).searchParams.get("runId") ?? undefined;

    let ref: string | undefined;
    let version: string | undefined;
    let dirty = false;
    if (runId) {
      const commit = await resolveRunCommit(runtimeEnv.id, runId);
      if (!commit) {
        return json(
          { error: "That run has no deployed commit (it may be a dev run)." },
          { status: 404 }
        );
      }
      ref = commit.sha;
      version = commit.version;
      dirty = commit.dirty;
    }

    const snapshot = await resolveDashboardAgentRepoSnapshot(runtimeEnv.projectId, { ref });
    if (!snapshot) {
      return json({ error: "No connected repository for this project." }, { status: 404 });
    }

    return json({ ...snapshot, version, dirty });
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to resolve dashboard agent repo snapshot", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
