import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  checkMessageParts,
  declaredBodyBytes,
  exceedsMessageBodyBytes,
  MAX_MESSAGE_BODY_BYTES,
  MESSAGE_TOO_LARGE_CODE,
  MESSAGE_TOO_LARGE_ERROR,
} from "~/components/dashboard-agent/message-limits";
import { $replica } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  dashboardAgentApiOrigin,
  dashboardAgentEnvironmentName,
  mintDashboardAgentUserActorToken,
  resolveDashboardAgentRepoSnapshot,
} from "~/services/dashboardAgent.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
import { readBoundedBodyText } from "~/utils/boundedRequestBody.server";
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

function tooLarge() {
  return json({ error: MESSAGE_TOO_LARGE_ERROR, code: MESSAGE_TOO_LARGE_CODE }, { status: 413 });
}

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

  // The declared size is refused before any lookup. It is advisory, so the read below is
  // bounded too: without it a chunked body would be buffered whole before being refused.
  if (exceedsMessageBodyBytes(declaredBodyBytes(request.headers))) {
    return tooLarge();
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

  // Membership-scoped: `(projectId, slug)` is not unique because every developer has their own
  // dev row, and a token must never be minted for someone else's environment — or for none.
  const runtimeEnv = await findEnvironmentBySlug(project.id, envParam, user.id);
  if (!runtimeEnv) return json({ error: "Environment not found" }, { status: 404 });
  const environmentName = dashboardAgentEnvironmentName(runtimeEnv.type);

  // Null without a connected GitHub repo, and the agent stays in assistant mode.
  const repoSnapshot = await resolveDashboardAgentRepoSnapshot(project.id);

  const read = await readBoundedBodyText(request, MAX_MESSAGE_BODY_BYTES);
  if (!read.ok) return tooLarge();

  const raw = read.text;
  let body = raw;
  try {
    const parsed = JSON.parse(raw) as {
      kind?: string;
      payload?: {
        trigger?: string;
        metadata?: Record<string, unknown>;
        message?: { parts?: unknown };
      };
    };
    // Actions are placed by the server only, and this proxy is the one path a browser
    // can reach `.in` through.
    if (parsed.payload?.trigger === "action") {
      return json({ error: "Not allowed" }, { status: 403 });
    }
    if (parsed.kind === "message" && parsed.payload) {
      // A body under the byte cap can still be one huge part or hundreds of small ones.
      if (checkMessageParts(parsed.payload.message?.parts) !== null) {
        return tooLarge();
      }
      parsed.payload.metadata = {
        ...(parsed.payload.metadata ?? {}),
        userActorToken: await mintDashboardAgentUserActorToken(user.id, {
          environmentId: runtimeEnv.id,
        }),
        apiOrigin,
        projectRef: project.externalRef,
        // Server-owned: the browser sends these too, and the eval opt-out and every tenancy
        // check key on them, so the client's copy must never win.
        organizationId: project.organizationId,
        userId: user.id,
        // `(projectId, slug)` isn't unique (dev is per-member), so anything addressing
        // one environment row uses this id. `environmentName` is for name-addressed tools.
        environmentId: runtimeEnv.id,
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
