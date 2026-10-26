import { json } from "@remix-run/server-runtime";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { canUseMonitoringAlerts } from "~/services/monitoringAlertsApi.server";
import { rbac } from "~/services/rbac.server";
import { authenticateUatOrApiRequest } from "~/services/uatRoutePreamble.server";

export async function authenticateDashboardAgent(
  request: Request
): Promise<{ userId: string; environmentId: string } | { error: Response }> {
  const authentication = await authenticateUatOrApiRequest(request);
  const actor = authentication?.userActor;
  if (!actor || actor.client !== "dashboard-agent") {
    return { error: json({ error: "Invalid or missing access token" }, { status: 401 }) };
  }
  if (!actor.environmentId) {
    return {
      error: json(
        { error: "This chat has no environment context.", code: "invalid_target" },
        { status: 400 }
      ),
    };
  }
  return { userId: actor.userId, environmentId: actor.environmentId };
}

export async function gateMonitoringAlerts(environment: AuthenticatedEnvironment, userId: string) {
  return canUseMonitoringAlerts(
    {
      id: environment.project.id,
      externalRef: environment.project.externalRef,
      organizationId: environment.organizationId,
      organizationSlug: environment.organization.slug,
      organizationFeatureFlags:
        (environment.organization.featureFlags as Record<string, unknown> | null) ?? null,
    },
    userId
  );
}

export async function authorizeAlerts(
  request: Request,
  environment: AuthenticatedEnvironment,
  action: "read" | "write"
): Promise<Response | undefined> {
  const auth = await rbac.authenticateUserActor(request, {
    organizationId: environment.organizationId,
    projectId: environment.project.id,
  });
  if (!auth.ok) {
    return json({ error: auth.error }, { status: auth.status });
  }
  if (!auth.ability.can(action, { type: "alerts", envType: environment.type })) {
    return json(
      { error: `You don't have permission to ${action === "read" ? "view" : "manage"} alerts` },
      { status: 403 }
    );
  }
}
