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

// Same-origin proxy for the chat "in"/append request. The transport routes the
// `in` endpoint here (and the `out` SSE stream direct to the Trigger API), so
// every turn passes through the dashboard's own session before reaching the
// agent. We use that hop to mint a fresh read-only delegated token for the
// signed-in user and inject it into the turn's metadata server-side. The token
// reaches the agent without ever touching the browser, and minting stays tied
// to the user's own session (no shared-secret backdoor). The token is scoped to
// the environment in this URL, which is what the agent's write-ish endpoints
// (watches, watch alerts) bind to — so a turn can only ever act in the
// environment the user is actually looking at.
//
// The append body is `{ kind, payload: { metadata, ... } }`; we add the token
// (plus the API origin and the server-vouched project ref + env) to
// `payload.metadata`. Only `kind === "message"` turns carry metadata — stop
// chunks pass through untouched. We forward only the headers the API needs and
// deliberately drop the dashboard session cookie.

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

  // When the project has a connected GitHub repo, resolve a signed source-archive
  // pointer (code mode). Null otherwise -> the agent stays in assistant mode.
  const repoSnapshot = await resolveDashboardAgentRepoSnapshot(project.id);

  // Inject the delegated token + context into the turn's metadata.
  const raw = await request.text();
  let body = raw;
  try {
    const parsed = JSON.parse(raw) as {
      kind?: string;
      payload?: { trigger?: string; metadata?: Record<string, unknown> };
    };
    // Actions are server business, not the browser's. A wake comes from the
    // watcher task and the investigate kick from our own server hop, both writing
    // to `.in` with an environment key — nothing arriving through this proxy may
    // claim to be one. Refusing here (rather than letting the agent's action schema
    // sort it out) keeps "an action was placed by the server" a real boundary: the
    // proxy is the one path a browser can reach `.in` through, and it is also where
    // a delegated token gets minted.
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
        // The canonical environment identity. `(projectId, slug)` isn't unique
        // (dev is per-member) and names are display-only, so anything that has to
        // address one specific environment row uses this id. `environmentName`
        // stays for back-compat with the agent's name-addressed tools.
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
