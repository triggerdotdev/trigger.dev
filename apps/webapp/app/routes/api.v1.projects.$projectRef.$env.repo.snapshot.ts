import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { authenticatedEnvironmentForAuthentication } from "~/services/apiAuth.server";
import {
  resolveDashboardAgentRepoSnapshot,
  resolveRunCommit,
} from "~/services/dashboardAgent.server";
import { authorizePatEnvironmentAccess } from "~/services/environmentVariableApiAccess.server";
import { logger } from "~/services/logger.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

// Resolve a signed source-archive pointer for the project's connected repo, used
// by the dashboard agent's code tools. With `?runId=run_...` it pins to the
// commit that run's deployed version came from (run-SHA pinning); without it,
// the tracked branch head. The GitHub token never leaves the server, only the
// short-lived signed URL is returned. A delegated user-actor token authenticates as its user and
// is gated on that user's env-tier role, like the JWT exchange.

const ParamsSchema = z.object({
  projectRef: z.string(),
  env: z.enum(["dev", "staging", "prod", "preview"]),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  try {
    const authentication = await authenticateUatOrApiRequest(request);
    if (!authentication) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const parsed = ParamsSchema.safeParse(params);
    if (!parsed.success) return json({ error: "Invalid Params" }, { status: 400 });
    const { projectRef, env } = parsed.data;

    const triggerBranch = request.headers.get("x-trigger-branch") ?? undefined;
    // An org-claim token reads the repo of any project in its org, so the agent can open code
    // for a sibling project. Membership is `findProjectByRef` inside the resolve.
    const runtimeEnv = await authenticatedEnvironmentForAuthentication(
      authentication.authenticationResult,
      projectRef,
      env,
      triggerBranch,
      { organizationScoped: true }
    );

    // The signed URL exposes the project's whole source tree, so gate it like the environment's
    // other secrets: env-tier `read:apiKeys`, the same check the JWT exchange applies.
    const denied = await authorizePatEnvironmentAccess({
      request,
      authType: authentication.authenticationResult.type,
      organizationId: runtimeEnv.organizationId,
      projectId: runtimeEnv.project.id,
      envType: runtimeEnv.type,
      resource: "apiKeys",
      action: "read",
    });
    if (denied) return denied;

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
