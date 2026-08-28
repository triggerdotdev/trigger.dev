import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { orgAllowsDashboardAgentTurnEvals } from "~/services/dashboardAgentEvalPolicy.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

/**
 * The gate the agent checks before it judges a turn. Only its own delegated user-actor
 * token is accepted, and the org is scoped to the token's user. Answers `false` rather than
 * an error whenever the setting can't be resolved, so the agent's fail-closed path is the
 * same for "off" and "unknown".
 */

const QuerySchema = z.object({ organizationId: z.string().min(1) });

// obs-map-disable request-context -- the only call here that can throw catches its own failure
// and logs it with organizationId, in dashboardAgentEvalPolicy.server.ts; the rest are early
// returns, and the one failure that does reach the boundary is auth, where no tenant is known yet.
export async function loader({ request }: LoaderFunctionArgs) {
  const authentication = await authenticateUatOrApiRequest(request);
  if (!authentication?.userActor) {
    return json({ error: "Invalid or missing access token" }, { status: 401 });
  }
  if (authentication.userActor.client !== "dashboard-agent") {
    return json({ error: "Not allowed", code: "forbidden_client" }, { status: 403 });
  }

  const parsed = QuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams.entries())
  );
  if (!parsed.success) {
    return json({ error: "organizationId is required" }, { status: 400 });
  }

  const turnEvalsEnabled = await orgAllowsDashboardAgentTurnEvals({
    userId: authentication.userActor.userId,
    organizationId: parsed.data.organizationId,
  });

  return json({ turnEvalsEnabled });
}
