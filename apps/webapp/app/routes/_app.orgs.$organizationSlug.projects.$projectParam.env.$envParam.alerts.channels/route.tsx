import { parseWithZod } from "@conform-to/zod/v4";
import { useLoaderData, useLocation, useNavigate } from "@remix-run/react";
import { useHydrated } from "remix-utils/use-hydrated";
import { defer, json } from "@remix-run/server-runtime";
import {
  AlertChannelFormSchema,
  formDataToAlertChannel,
} from "~/components/alerts/AlertChannelForm";
import {
  AlertChannelsDialog,
  type AlertChannelsData,
} from "~/components/alerts/AlertChannelsDialog";
import { alertChannelActionSchema } from "~/components/alerts/AlertChannelsBody";
import { hasLegacyAlerts } from "~/components/alerts/hasLegacyAlerts.server";
import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectWithOrgFlagsBySlug } from "~/models/project.server";
import { AlertChannelListPresenter } from "~/presenters/v3/AlertChannelListPresenter.server";
import { NewAlertChannelPresenter } from "~/presenters/v3/NewAlertChannelPresenter.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import {
  EnvironmentParamSchema,
  v3ProjectAlertChannelsPath,
  v3ProjectAlertsPath,
} from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { alertsWorker } from "~/v3/alertsWorker.server";
import { requireAlertsEnabledOrRedirect } from "~/v3/canUseAlertsList.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  canAcrossEnvironments,
  requireAcrossEnvironments,
} from "~/v3/services/dashboardResourceAccess.server";
import { UpdateAlertChannelService } from "~/v3/services/alerts/updateAlertChannel.server";
import {
  authorizedChannelWhere,
  writeAuthorizedChannel,
  type AuthorizedChannel,
} from "~/v3/services/alerts/authorizedChannelWrite.server";

export const meta = pageMeta("Alert channels");

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "alerts" } },
  },
  async ({ params, user, ability }) => {
    await requireAlertsEnabledOrRedirect(user.id, params);
    const { projectParam, organizationSlug } = params;

    const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, user.id);
    if (!project) {
      throw new Response(undefined, { status: 404, statusText: "Project not found" });
    }

    const canWriteChannel = (channel: { environmentTypes: RuntimeEnvironmentType[] }) =>
      canAcrossEnvironments(ability, "write", "alerts", channel.environmentTypes);
    const canWrite = canAcrossEnvironments(ability, "write", "alerts", []);
    const canDelete = canAcrossEnvironments(ability, "delete", "alerts", []);
    const data = await new AlertChannelListPresenter().call(project.id, undefined, canWriteChannel);
    const { slack } = await new NewAlertChannelPresenter().call(project.id);
    return defer({
      ...data,
      alertChannels: data.alertChannels.map((channel) => ({
        ...channel,
        canWrite: canWriteChannel(channel),
        canDelete: canAcrossEnvironments(ability, "delete", "alerts", channel.environmentTypes),
      })),
      canWrite,
      canDelete,
      form: {
        slack,
        emailAlertsEnabled:
          env.ALERT_FROM_EMAIL !== undefined && env.ALERT_RESEND_API_KEY !== undefined,
      },
      ...(await hasLegacyAlerts(project.id)),
    }) as unknown as Response;
  }
);

export function resolveChannelsRedirect(
  requested: FormDataEntryValue | null,
  organization: { slug: string },
  project: { slug: string },
  environment: { slug: string }
) {
  const alertsPath = v3ProjectAlertsPath(organization, project, environment);
  if (
    typeof requested === "string" &&
    requested.startsWith(alertsPath) &&
    (requested.length === alertsPath.length || "/?".includes(requested[alertsPath.length]!))
  ) {
    return requested;
  }
  return v3ProjectAlertChannelsPath(organization, project, environment);
}

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "write", resource: { type: "alerts" } },
  },
  async ({ params, user, request, ability }) => {
    await requireAlertsEnabledOrRedirect(user.id, params);
    const userId = user.id;
    const { organizationSlug, projectParam, envParam } = params;

    if (request.method.toUpperCase() !== "POST") {
      throw new Response("Method Not Allowed", { status: 405 });
    }

    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: alertChannelActionSchema });
    if (submission.status !== "success") {
      return json(submission.reply());
    }

    const project = await findProjectWithOrgFlagsBySlug(organizationSlug, projectParam, userId);
    if (!project) {
      return json(submission.reply({ formErrors: ["Project not found"] }));
    }

    const { id } = submission.value;
    const requested = submission.value.environmentTypes ?? [];
    const mutate = async <T,>(write: (channel: AuthorizedChannel) => Promise<T | null>) => {
      const outcome = await writeAuthorizedChannel(
        prisma,
        { id, projectId: project.id },
        (environmentTypes) =>
          requireAcrossEnvironments(
            ability,
            submission.value.action === "delete" ? "delete" : "write",
            "alerts",
            [...environmentTypes, ...requested]
          ),
        write
      );
      if (!outcome.found) {
        throw new Response(undefined, { status: 404, statusText: "Channel not found" });
      }
      return outcome.result;
    };

    const redirectTo = resolveChannelsRedirect(
      formData.get("redirectTo"),
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam }
    );

    try {
      switch (submission.value.action) {
        case "delete": {
          const channel = await mutate(async (channel) => {
            const deleted = await prisma.projectAlertChannel.deleteMany({
              where: authorizedChannelWhere(channel),
            });
            return deleted.count > 0 ? channel : null;
          });
          return redirectWithSuccessMessage(redirectTo, request, `Deleted ${channel.name} channel`);
        }
        case "disable": {
          const channel = await mutate(async (channel) => {
            const updated = await prisma.projectAlertChannel.updateMany({
              where: authorizedChannelWhere(channel),
              data: { enabled: false },
            });
            return updated.count > 0 ? channel : null;
          });
          return redirectWithSuccessMessage(
            redirectTo,
            request,
            `Disabled ${channel.name} channel`
          );
        }
        case "update": {
          const form = parseWithZod(formData, { schema: AlertChannelFormSchema });
          if (form.status !== "success") {
            return json(form.reply());
          }
          if (requested.length === 0) {
            return json(form.reply({ formErrors: ["Select at least one environment"] }));
          }
          try {
            const channel = await mutate((channel) =>
              new UpdateAlertChannelService().call(
                project.id,
                id,
                { ...formDataToAlertChannel(form.value), environmentTypes: requested },
                channel.environmentTypes
              )
            );
            return redirectWithSuccessMessage(
              redirectTo,
              request,
              `Updated ${channel.name} channel`
            );
          } catch (error) {
            if (error instanceof ServiceValidationError) {
              return json(form.reply({ formErrors: [error.message] }));
            }
            throw error;
          }
        }
        case "enable": {
          const channel = await mutate(async (channel) => {
            const updated = await prisma.projectAlertChannel.updateMany({
              where: authorizedChannelWhere(channel),
              data: { enabled: true },
            });
            return updated.count > 0 ? channel : null;
          });

          if (channel.alertTypes.includes("ERROR_GROUP")) {
            await alertsWorker.enqueue({
              id: `evaluateErrorAlerts:${project.id}`,
              job: "v3.evaluateErrorAlerts",
              payload: { projectId: project.id, scheduledAt: Date.now() },
            });
          }

          return redirectWithSuccessMessage(redirectTo, request, `Enabled ${channel.name} channel`);
        }
      }
    } catch (error) {
      if (error instanceof Response) throw error;
      logger.error("Failed to update alert channel", {
        organizationId: project.organizationId,
        projectId: project.id,
        userId,
        error,
      });
      throw error;
    }
  }
);

export default function Page() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigate = useNavigate();
  const { search } = useLocation();
  const data = useLoaderData<AlertChannelsData>();
  const hydrated = useHydrated();
  return (
    <AlertChannelsDialog
      open={hydrated}
      data={data}
      onClose={() =>
        navigate(`${v3ProjectAlertsPath(organization, project, environment)}${search}`, {
          replace: true,
        })
      }
    />
  );
}
