import { trace } from "@opentelemetry/api";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { featuresForRequest } from "~/features.server";
import { runTraceUnavailableBeforeRead } from "~/presenters/v3/runTraceSetup.server";
import {
  SessionRunsPresenter,
  SessionRunsSearchParams,
  sessionRunSelect,
  type SessionRunsPage,
} from "~/presenters/v3/SessionRunsPresenter.server";
import { findSessionForRunsView } from "~/presenters/v3/sessionRunsAccess.server";
import { runsPageRequestKind } from "~/presenters/v3/sessionTraceRequestKind";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { requestFeature, viewerOf } from "~/services/requestFeature.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { runStore } from "~/v3/runStore.server";

const ParamsSchema = EnvironmentParamSchema.extend({ sessionParam: z.string() });

// One body for every miss, so a response doesn't reveal whether the flag is on.
function notFound(reason: string) {
  trace.getActiveSpan()?.setAttribute("sessionRuns.notFoundReason", reason);
  return json({ error: "Not found" }, { status: 404 });
}

function recordUnavailableRuns(page: SessionRunsPage) {
  for (const { unavailable } of Object.values(page.view)) {
    if (unavailable) requestFeature.recordFallback("runs", unavailable);
  }
}

// GET: a page of a session's runs for the Trace tab, newest first.
export const loader = dashboardLoader(
  {
    params: ParamsSchema,
    searchParams: SessionRunsSearchParams,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "sessions" } },
    feature: "session.trace",
  },
  async ({ params, searchParams, user, request }) => {
    requestFeature.describe({ kind: runsPageRequestKind(searchParams), viewer: viewerOf(user) });

    const access = await findSessionForRunsView({
      organizationSlug: params.organizationSlug,
      projectSlug: params.projectParam,
      environmentSlug: params.envParam,
      sessionParam: params.sessionParam,
      userId: user.id,
      isAdmin: user.admin,
      isManagedCloud: featuresForRequest(request).isManagedCloud,
    });
    if (!access.ok) return notFound(access.error);

    const { session } = access;
    const presenter = new SessionRunsPresenter({
      replica: $replica,
      findRunsByIds: (ids) => runStore.findRunsByIds(ids, { select: sessionRunSelect }, $replica),
      unavailableBeforeRead: runTraceUnavailableBeforeRead,
      emergencySpanCap: env.TRACE_VIEW_EMERGENCY_SPAN_CAP,
      v1RerouteEnabled: env.EVENT_REPOSITORY_V1_REROUTE_ENABLED,
    });

    const page = await presenter.call({
      session: {
        id: session.id,
        projectId: session.projectId,
        runtimeEnvironmentId: session.runtimeEnvironmentId,
      },
      pageSize: searchParams["page[size]"],
      after: searchParams["page[after]"],
      runFriendlyId: searchParams.run,
      showDeletedLogs: user.isImpersonating,
    });
    if (!page) return notFound("Run not in session");

    // Polls and focus refreshes re-read rows already on screen.
    const kind = runsPageRequestKind(searchParams);
    if (kind !== "poll" && kind !== "focus") recordUnavailableRuns(page);

    return json<SessionRunsPage>(page);
  }
);
