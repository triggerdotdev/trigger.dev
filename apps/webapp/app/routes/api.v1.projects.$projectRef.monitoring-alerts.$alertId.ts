import { json } from "@remix-run/server-runtime";
import {
  getAlert,
  listAlertEvents,
  resolveAlert,
} from "~/v3/services/alerts/storage/alertStore.server";
import { stopAlertAndUnschedule } from "~/v3/services/alerts/alertLifecycle.server";
import { ungroupAlert } from "~/v3/services/alerts/alertGroups.server";
import { GROUP_CAPABILITY_KEY } from "@internal/alert-contracts";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import {
  alertsInAnyEnvironment,
  alertsEnvironmentForbidden,
  canAccessAlertsIn,
  canUseMonitoringAlerts,
  findAlertEnvironmentType,
  findMonitoringAlertsProject,
  monitoringAlertsRouteContext,
} from "~/services/monitoringAlertsApi.server";
import {
  createActionPATApiRoute,
  createLoaderPATApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { assertUserActorEnvironment } from "~/services/userActorEnvironment.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
  alertId: z.string(),
});

const ActionBodySchema = z.object({
  action: z.enum(["resolve", "stop", "ungroup"]),
});

export const loader = createLoaderPATApiRoute(
  {
    params: ParamsSchema,
    context: monitoringAlertsRouteContext,
    authorization: { action: "read", resource: alertsInAnyEnvironment },
  },
  async ({ params, authentication, ability }) => {
    try {
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

      const alert = await getAlert(prisma, {
        id: params.alertId,
        projectId: project.id,
      });
      if (!alert) {
        return json({ error: "Alert not found" }, { status: 404 });
      }
      assertUserActorEnvironment(authentication.userActor, alert.environmentId);
      if (!(await canAccessAlertsIn(ability, "read", alert.environmentId))) {
        return alertsEnvironmentForbidden("read");
      }

      const events = await listAlertEvents(prisma, alert.id, { limit: 50 });

      const environmentType = await findAlertEnvironmentType(alert.environmentId);

      return json({ alert, events, environmentType });
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to load monitoring alert", {
        userId: authentication.userId,
        error,
      });
      throw error;
    }
  }
);

export const action = createActionPATApiRoute(
  {
    method: "POST",
    params: ParamsSchema,
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

    const body = ActionBodySchema.safeParse(rawBody);
    if (!body.success) {
      return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
    }

    try {
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

      const alert = await getAlert(prisma, {
        id: params.alertId,
        projectId: project.id,
      });
      if (!alert) {
        return json({ error: "Alert not found" }, { status: 404 });
      }
      assertUserActorEnvironment(authentication.userActor, alert.environmentId);
      if (!(await canAccessAlertsIn(ability, "write", alert.environmentId))) {
        return alertsEnvironmentForbidden("write");
      }

      if (body.data.action === "ungroup") {
        if (!(await canAccessAlertsIn(ability, "delete", alert.environmentId))) {
          return alertsEnvironmentForbidden("delete");
        }
        if (alert.capabilityKey !== GROUP_CAPABILITY_KEY) {
          return json({ error: "Alert is not a group" }, { status: 409 });
        }
        await ungroupAlert(prisma, {
          groupId: alert.id,
          projectId: alert.projectId,
          environmentId: alert.environmentId,
        });
        return json({ alert });
      }

      const outcome =
        body.data.action === "resolve"
          ? await resolveAlert(prisma, {
              id: alert.id,
              actorId: authentication.userId,
            })
          : await stopAlertAndUnschedule(prisma, {
              id: alert.id,
              actorId: authentication.userId,
              projectId: alert.projectId,
              environmentId: alert.environmentId,
            });

      if (!outcome) {
        const verb = body.data.action === "resolve" ? "resolved" : "stopped";
        return json({ error: `Alert cannot be ${verb} from its current state` }, { status: 409 });
      }

      return json({ alert: outcome.alert, event: outcome.event });
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to update monitoring alert", {
        userId: authentication.userId,
        error,
      });
      throw error;
    }
  }
);
