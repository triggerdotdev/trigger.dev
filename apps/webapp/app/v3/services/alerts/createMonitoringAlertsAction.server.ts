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
import {
  GROUP_CAPABILITY_KEY,
  validateConditionParams,
  type AlertCapability,
} from "@internal/alert-contracts";
import { createAlertGroup } from "~/v3/services/alerts/alertGroups.server";
import {
  createAlertAndSchedule,
  type AlertLifecycleDeps,
} from "~/v3/services/alerts/alertLifecycle.server";
import { stateFields, validateAlertDraft } from "~/v3/services/alerts/validateAlertDraft.server";
import { validateAlertNotifiers } from "~/v3/services/alerts/validateAlertNotifiers.server";
import {
  buildAlertFromDraft,
  InvalidQueryAlertError,
  QUERY_DOMAIN_ERRORS,
  type AlertDraftScope,
  type NewAlertInput,
} from "~/v3/services/alerts/createAlertFromDraft.server";
import {
  MonitoringAlertsParamsSchema,
  MonitoringAlertsCreateBodySchema,
  type MonitoringAlertsMemberBody,
} from "~/v3/services/alerts/monitoringAlertsSchemas";

type DraftContext = {
  organizationId: string;
  projectId: string;
  environmentId: string;
  createdBy: string;
};

function draftErrorResponse(
  draft: MonitoringAlertsMemberBody,
  capability: AlertCapability | undefined,
  isGroup: boolean
): Response | null {
  const draftError = isGroup
    ? null
    : validateAlertDraft({
        capability,
        capabilityKey: draft.capabilityKey,
        surface: "mcp",
        conditionKind: draft.condition.kind,
        quietWindowSec:
          draft.condition.kind === "absence" ? draft.condition.quietWindowSec : undefined,
        scope: draft.params.scope,
        ...stateFields(draft.condition),
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

  if (capability && "params" in draft.condition && draft.condition.params) {
    try {
      validateConditionParams(draft.condition.params, capability.binding.params ?? []);
    } catch (e: unknown) {
      return json({ error: (e as Error).message }, { status: 400 });
    }
  }
  return null;
}

function alertInput(draft: MonitoringAlertsMemberBody, context: DraftContext): NewAlertInput {
  const shared = {
    ...context,
    capabilityKey: draft.capabilityKey,
    condition: draft.condition,
    expiresAt: draft.behavior.expiresAt ? new Date(draft.behavior.expiresAt) : undefined,
    notifiers: draft.notifiers,
    name: draft.name,
  };
  return draft.capabilityKey === "custom.query"
    ? buildAlertFromDraft({
        ...shared,
        scope: draft.params.scope as AlertDraftScope,
        query: draft.query,
        querySignalChoice: draft.signal,
      })
    : {
        ...shared,
        params: {
          environmentId: context.environmentId,
          scope: draft.params.scope,
          windowSec: draft.params.windowSec,
        },
      };
}

function draftDomainErrorResponse(error: unknown): Response | null {
  if (error instanceof InvalidQueryAlertError) {
    return json({ error: error.message }, { status: 422 });
  }
  if (QUERY_DOMAIN_ERRORS.some((cls) => error instanceof cls)) {
    return json({ error: (error as Error).message }, { status: 400 });
  }
  return null;
}

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
      const isGroup = body.data.capabilityKey === GROUP_CAPABILITY_KEY;
      const { condition } = body.data;
      const memberAlertIds = condition.kind === "state" ? condition.memberAlertIds : undefined;
      const members = body.data.members ?? [];
      if (isGroup !== (!!memberAlertIds || members.length > 0)) {
        return json(
          {
            error: `condition.memberAlertIds and members are only valid for ${GROUP_CAPABILITY_KEY}`,
          },
          { status: 400 }
        );
      }
      if (
        members.some(
          (m) =>
            m.capabilityKey === GROUP_CAPABILITY_KEY ||
            (m.condition.kind === "state" && m.condition.memberAlertIds)
        )
      ) {
        return json({ error: "A group can't contain another group" }, { status: 400 });
      }
      const draftResponse = [
        draftErrorResponse(body.data, capability, isGroup),
        ...members.map((m) => draftErrorResponse(m, getCapability(m.capabilityKey), false)),
      ].find(Boolean);
      if (draftResponse) return draftResponse;

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

      for (const draft of [body.data, ...members]) {
        const notifierError = await validateAlertNotifiers({
          notifiers: draft.notifiers,
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
      }

      const draftContext = {
        organizationId: project.organizationId,
        projectId: project.id,
        environmentId: environment.id,
        createdBy: authentication.userId,
      };

      if (isGroup) {
        let memberInputs: NewAlertInput[];
        try {
          memberInputs = members.map((member) => alertInput(member, draftContext));
        } catch (error) {
          const response = draftDomainErrorResponse(error);
          if (response) return response;
          throw error;
        }
        const result = await createAlertGroup(
          prisma,
          {
            organizationId: project.organizationId,
            projectId: project.id,
            environmentId: environment.id,
            memberAlertIds: memberAlertIds ?? [],
            members: memberInputs,
            compositeMode: (condition.kind === "state" && condition.compositeMode) || "any",
            name: body.data.name,
            notifiers: body.data.notifiers,
            expiresAt: body.data.behavior.expiresAt
              ? new Date(body.data.behavior.expiresAt)
              : undefined,
            createdBy: authentication.userId,
          },
          deps.lifecycle
        );
        return result.ok
          ? json({ alert: result.alert })
          : json({ error: result.error }, { status: 422 });
      }

      try {
        const alert = await createAlertAndSchedule(
          prisma,
          alertInput(body.data, draftContext),
          deps.lifecycle
        );
        return json({ alert });
      } catch (error) {
        const response = draftDomainErrorResponse(error);
        if (response) return response;
        logger.error("Failed to create monitoring alert", {
          error,
          projectRef: params.projectRef,
        });
        return json({ error: "Something went wrong, please try again." }, { status: 500 });
      }
    }
  );
}
