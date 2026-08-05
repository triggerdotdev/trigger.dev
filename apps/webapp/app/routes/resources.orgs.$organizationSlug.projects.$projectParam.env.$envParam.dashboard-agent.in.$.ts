import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import {
  dashboardAgentApiOrigin,
  dashboardAgentEnvironmentName,
  mintDashboardAgentUserActorToken,
  resolveDashboardAgentRepoSnapshot,
} from "~/services/dashboardAgent.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { canAccessDashboardAgent } from "~/v3/canAccessDashboardAgent.server";

// Same-origin proxy for the chat append request. It mints a read-only delegated token scoped
// to the environment in this URL, so the token never reaches the browser.

const FORWARDED_HEADERS = [
  "authorization",
  "content-type",
  "x-part-id",
  "x-trigger-source",
  "x-trigger-branch",
];

export async function action({ request, params }: ActionFunctionArgs) {
  const user = await requireUser(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  if (
    !(await canAccessDashboardAgent({
      userId: user.id,
      isAdmin: user.admin,
      isImpersonating: user.isImpersonating,
      organizationSlug,
    }))
  ) {
    return json({ error: "Not found" }, { status: 404 });
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, user.id);
  if (!project) return json({ error: "Project not found" }, { status: 404 });

  // The SDK builds the upstream path (`realtime/v1/sessions/{chatId}/in/append`);
  // it arrives here as the splat. Forward it verbatim to the Trigger API.
  const upstreamPath = params["*"];
  if (!upstreamPath) return json({ error: "Not found" }, { status: 404 });

  const apiOrigin = dashboardAgentApiOrigin();
  const url = new URL(request.url);
  const upstreamUrl = `${apiOrigin.replace(/\/$/, "")}/${upstreamPath}${url.search}`;

  // Resolve the dashboard env slug to the canonical API env name its tools use.
  const runtimeEnv = await $replica.runtimeEnvironment.findFirst({
    where: { projectId: project.id, slug: envParam },
    select: { id: true, type: true },
  });
  const environmentName = dashboardAgentEnvironmentName(runtimeEnv?.type);

  // Null without a connected GitHub repo, and the agent stays in assistant mode.
  const repoSnapshot = await resolveDashboardAgentRepoSnapshot(project.id);

  const raw = await request.text();
  let body = raw;
  try {
    const parsed = JSON.parse(raw) as {
      kind?: string;
      payload?: { trigger?: string; metadata?: Record<string, unknown> };
    };
    // Actions are placed by the server only, and this proxy is the one path a browser
    // can reach `.in` through.
    if (parsed.payload?.trigger === "action") {
      return json({ error: "Not allowed" }, { status: 403 });
    }
    if (parsed.kind === "message" && parsed.payload) {
      parsed.payload.metadata = {
        ...(parsed.payload.metadata ?? {}),
        userActorToken: await mintDashboardAgentUserActorToken(user.id, {
          environmentId: runtimeEnv?.id,
        }),
        apiOrigin,
        projectRef: project.externalRef,
        // `(projectId, slug)` isn't unique (dev is per-member), so anything addressing
        // one environment row uses this id. `environmentName` is for name-addressed tools.
        environmentId: runtimeEnv?.id,
        environmentName,
        ...(repoSnapshot ? { repoSnapshot } : {}),
      };
      body = JSON.stringify(parsed);
    }
  } catch {
    // Non-JSON or unexpected shape — forward unchanged rather than break the turn.
  }

  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  try {
    const upstream = await fetch(upstreamUrl, { method: "POST", headers, body });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch (error) {
    logger.error("Dashboard agent in-proxy failed", { error, upstreamPath });
    return json({ error: "The dashboard agent couldn't reach the run." }, { status: 502 });
  }
}
