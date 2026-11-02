import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import {
  alertsInAnyEnvironment,
  alertsEnvironmentForbidden,
  canUseMonitoringAlerts,
  defaultCapabilityLookup,
  findMonitoringAlertsProject,
  monitoringAlertsRouteContext,
  resolveMonitoringAlertsEnvironment,
  type CapabilityLookup,
} from "~/services/monitoringAlertsApi.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { assertUserActorEnvironment } from "~/services/userActorEnvironment.server";
import { logger } from "~/services/logger.server";
import { validateConditionParams } from "@internal/alert-contracts";
import {
  createAlertAndSchedule,
  type AlertLifecycleDeps,
} from "~/v3/services/alerts/alertLifecycle.server";
import { stateFields, validateAlertDraft } from "~/v3/services/alerts/validateAlertDraft.server";
import { validateAlertNotifiers } from "~/v3/services/alerts/validateAlertNotifiers.server";
import {
  createAlertFromDraft,
  InvalidQueryAlertError,
  QUERY_DOMAIN_ERRORS,
  type AlertDraftScope,
} from "~/v3/services/alerts/createAlertFromDraft.server";
import {
  MonitoringAlertsParamsSchema,
  MonitoringAlertsCreateBodySchema,
} from "~/v3/services/alerts/monitoringAlertsSchemas";

export function createMonitoringAlertsAction(
  deps: { getCapability?: CapabilityLookup; lifecycle?: AlertLifecycleDeps } = {}
) {
  const getCapability = deps.getCapability ?? defaultCapabilityLookup;

  return createActionPATApiRoute(
    {
      method: "POST",
      params: MonitoringAlertsParamsSchema,
      context: monitoringAlertsRouteContext,
      authorization: { action: "write", resource: alertsInAnyEnvironment },
    },
    async ({ request, params, authentication, ability }) => {
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return json({ error: "Invalid request body" }, { status: 400 });
      }

      const body = MonitoringAlertsCreateBodySchema.safeParse(rawBody);
      if (!body.success) {
        return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
      }

      const project = await findMonitoringAlertsProject(params.projectRef, authentication.userId);
      if (!project) {
        return json({ error: "Project not found" }, { status: 404 });
      }

      if (!(await canUseMonitoringAlerts(project, authentication.userId))) {
        return json(
          { error: "Monitoring alerts are not enabled for this project" },
          { status: 403 }
        );
      }

      const capability = getCapability(body.data.capabilityKey);
      const draftError = validateAlertDraft({
        capability,
        capabilityKey: body.data.capabilityKey,
        surface: "mcp",
        conditionKind: body.data.condition.kind,
        quietWindowSec:
          body.data.condition.kind === "absence" ? body.data.condition.quietWindowSec : undefined,
        scope: body.data.params.scope,
        ...stateFields(body.data.condition),
      });
      if (draftError) {
        return json(
          { error: draftError.message },
          {
            status:
              draftError.reason === "scope" ||
              draftError.reason === "components" ||
              draftError.reason === "signals"
                ? 400
                : 422,
          }
        );
      }

      if (capability && "params" in body.data.condition && body.data.condition.params) {
        const declared = capability.binding.params ?? [];
        try {
          validateConditionParams(body.data.condition.params, declared);
        } catch (e: unknown) {
          return json({ error: (e as Error).message }, { status: 400 });
        }
      }

      const environment = await resolveMonitoringAlertsEnvironment({
        projectId: project.id,
        environment: body.data.environment,
        branch: body.data.branch,
        userId: authentication.userId,
      });
      if (!environment) {
        return json({ error: "Environment not found" }, { status: 404 });
      }
      assertUserActorEnvironment(authentication.userActor, environment.id);
      if (!ability.can("write", { type: "alerts", envType: environment.type })) {
        return alertsEnvironmentForbidden("write");
      }

      const notifierError = await validateAlertNotifiers({
        notifiers: body.data.notifiers,
        projectId: project.id,
        organizationId: project.organizationId,
        userId: authentication.userId,
        environmentType: environment.type,
      });
      if (notifierError) {
        return json(
          { error: notifierError.message },
          { status: notifierError.reason === "channel" ? 422 : 400 }
        );
      }

      if (body.data.capabilityKey === "custom.query") {
        try {
          const alert = await createAlertFromDraft(
            prisma,
            {
              organizationId: project.organizationId,
              projectId: project.id,
              environmentId: environment.id,
              capabilityKey: body.data.capabilityKey,
              scope: body.data.params.scope as AlertDraftScope,
              condition: body.data.condition,
              expiresAt: body.data.behavior.expiresAt
                ? new Date(body.data.behavior.expiresAt)
                : undefined,
              notifiers: body.data.notifiers,
              name: body.data.name,
              createdBy: authentication.userId,
              query: body.data.query,
              querySignalChoice: body.data.signal,
            },
            deps.lifecycle
          );
          return json({ alert });
        } catch (error) {
          if (error instanceof InvalidQueryAlertError) {
            return json({ error: error.message }, { status: 422 });
          }
          if (QUERY_DOMAIN_ERRORS.some((cls) => error instanceof cls)) {
            return json({ error: (error as Error).message }, { status: 400 });
          }
          logger.error("Failed to create monitoring alert", {
            error,
            projectRef: params.projectRef,
          });
          return json({ error: "Something went wrong, please try again." }, { status: 500 });
        }
      }

      try {
        const alert = await createAlertAndSchedule(
          prisma,
          {
            organizationId: project.organizationId,
            projectId: project.id,
            environmentId: environment.id,
            capabilityKey: body.data.capabilityKey,
            params: {
              environmentId: environment.id,
              scope: body.data.params.scope,
              windowSec: body.data.params.windowSec,
            },
            condition: body.data.condition,
            expiresAt: body.data.behavior.expiresAt
              ? new Date(body.data.behavior.expiresAt)
              : undefined,
            notifiers: body.data.notifiers,
            name: body.data.name,
            createdBy: authentication.userId,
          },
          deps.lifecycle
        );

        return json({ alert });
      } catch (error) {
        logger.error("Failed to create monitoring alert", {
          error,
          projectRef: params.projectRef,
        });
        return json({ error: "Something went wrong, please try again." }, { status: 500 });
      }
    }
  );
}
