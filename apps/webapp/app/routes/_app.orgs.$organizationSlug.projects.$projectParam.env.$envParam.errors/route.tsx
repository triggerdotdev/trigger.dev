import { parseWithZod } from "@conform-to/zod/v4";
import { Outlet, useNavigate } from "@remix-run/react";
import { json } from "@remix-run/server-runtime";
import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import { useCallback } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageContainer } from "~/components/layout/AppLayout";
import {
  ConfigureErrorAlerts,
  ErrorAlertsFormSchema,
} from "~/components/errors/ConfigureErrorAlerts";
import { Callout } from "~/components/primitives/Callout";
import { Sheet, SheetContent } from "~/components/primitives/SheetV3";
import { prisma } from "~/db.server";
import { ErrorAlertChannelPresenter } from "~/presenters/v3/ErrorAlertChannelPresenter.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { env } from "~/env.server";
import {
  EnvironmentParamSchema,
  v3ErrorsConnectToSlackPath,
  v3ErrorsPath,
} from "~/utils/pathBuilder";
import {
  AlertChannelChangedError,
  type CreateAlertChannelOptions,
  CreateAlertChannelService,
} from "~/v3/services/alerts/createAlertChannel.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  canAcrossEnvironments,
  requireAcrossEnvironments,
} from "~/v3/services/dashboardResourceAccess.server";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
  },
  async ({ params, user, ability }) => {
    const userId = user.id;
    const { projectParam, organizationSlug, envParam } = params;

    const project = await findProjectBySlug(organizationSlug, projectParam, userId);
    if (!project) {
      throw new Response("Project not found", { status: 404 });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!environment) {
      throw new Response("Environment not found", { status: 404 });
    }

    const channelEnvironments = ability.can("read", { type: "alerts", envType: environment.type })
      ? await prisma.projectAlertChannel.findMany({
          where: {
            projectId: project.id,
            alertTypes: { has: "ERROR_GROUP" },
            environmentTypes: { has: environment.type },
          },
          select: { environmentTypes: true },
        })
      : undefined;
    const canReadAlerts =
      channelEnvironments !== undefined &&
      channelEnvironments.every((ch) =>
        canAcrossEnvironments(ability, "read", "alerts", ch.environmentTypes)
      );
    const alertData = canReadAlerts
      ? await new ErrorAlertChannelPresenter().call(project.id, environment.type)
      : undefined;

    const connectToSlackHref = v3ErrorsConnectToSlackPath({ slug: organizationSlug }, project, {
      slug: envParam,
    });

    const errorsPath = v3ErrorsPath({ slug: organizationSlug }, project, { slug: envParam });

    return typedjson({
      alertData,
      projectRef: project.externalRef,
      projectId: project.id,
      environmentType: environment.type,
      connectToSlackHref,
      errorsPath,
    });
  }
);

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "write", resource: { type: "alerts" } },
  },
  async ({ params, user, request, ability }) => {
    const userId = user.id;
    const { projectParam, organizationSlug, envParam } = params;

    if (request.method.toUpperCase() !== "POST") {
      return json({ status: 405, error: "Method Not Allowed" }, { status: 405 });
    }

    const project = await findProjectBySlug(organizationSlug, projectParam, userId);
    if (!project) {
      return json({ error: "Project not found" }, { status: 404 });
    }

    const environment = await findEnvironmentBySlug(project.id, envParam, userId);
    if (!environment) {
      return json({ error: "Environment not found" }, { status: 404 });
    }

    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: ErrorAlertsFormSchema });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    const { slackChannel, slackIntegrationId } = submission.value;
    const seenEmails = new Set<string>();
    const emails = submission.value.emails
      .map((email) => email.trim())
      .filter((email) => {
        const normalized = email.toLowerCase();
        if (seenEmails.has(normalized)) return false;
        seenEmails.add(normalized);
        return true;
      });
    const webhooks = [...new Set(submission.value.webhooks.map((url) => url.trim()))];

    const emailEnabled =
      env.ALERT_FROM_EMAIL !== undefined && env.ALERT_RESEND_API_KEY !== undefined;
    const slackEnabled = !!slackIntegrationId;

    const existingChannels = await prisma.projectAlertChannel.findMany({
      where: {
        projectId: project.id,
        alertTypes: { has: "ERROR_GROUP" },
        environmentTypes: { has: environment.type },
      },
    });
    const slackTarget = slackEnabled && slackChannel ? slackChannel.split("/") : [];
    const requestedKeys = new Set<string>([
      ...(slackTarget[0] && slackTarget[1] ? [`error-slack:${environment.type}`] : []),
      ...(emailEnabled ? emails.map((email) => `error-email:${email}:${environment.type}`) : []),
      ...webhooks.map((url) => `error-webhook:${url}:${environment.type}`),
    ]);
    const keyMatches = (
      await prisma.projectAlertChannel.findMany({
        where: {
          projectId: project.id,
          deduplicationKey: { startsWith: "error-", endsWith: `:${environment.type}` },
        },
      })
    ).filter((ch) => ch.deduplicationKey && requestedKeys.has(ch.deduplicationKey));
    requireAcrossEnvironments(ability, "write", "alerts", [
      ...existingChannels.flatMap((ch) => ch.environmentTypes),
      ...keyMatches.flatMap((ch) => ch.environmentTypes),
      environment.type,
    ]);

    const editableTypes = new Set<string>(["WEBHOOK"]);
    if (emailEnabled) {
      editableTypes.add("EMAIL");
    }
    if (slackEnabled) {
      editableTypes.add("SLACK");
    }

    const channelsToDelete = existingChannels.filter(
      (ch) =>
        !(ch.deduplicationKey && requestedKeys.has(ch.deduplicationKey)) &&
        editableTypes.has(ch.type) &&
        ch.alertTypes.length === 1 &&
        ch.alertTypes[0] === "ERROR_GROUP"
    );
    if (channelsToDelete.length > 0) {
      requireAcrossEnvironments(
        ability,
        "delete",
        "alerts",
        channelsToDelete.flatMap((ch) => ch.environmentTypes)
      );
    }

    const service = new CreateAlertChannelService();
    const environmentTypes = [environment.type];
    const authorizedChannel = (deduplicationKey: string) => {
      const match = keyMatches.find((ch) => ch.deduplicationKey === deduplicationKey);
      return match ? { id: match.id, environmentTypes: match.environmentTypes } : null;
    };
    const changed = () =>
      json(submission.reply({ formErrors: ["Alert channel changed, retry"] }), { status: 409 });

    if (slackEnabled && slackChannel) {
      const [channelId, channelName] = slackChannel.split("/");
      if (channelId && channelName) {
        const options: CreateAlertChannelOptions = {
          name: `Error alert to #${channelName}`,
          alertTypes: ["ERROR_GROUP"],
          environmentTypes,
          deduplicationKey: `error-slack:${environment.type}`,
          authorizedChannel: authorizedChannel(`error-slack:${environment.type}`),
          channel: {
            type: "SLACK",
            channelId,
            channelName,
            integrationId: slackIntegrationId,
          },
        };
        try {
          await service.call(project.externalRef, userId, options);
        } catch (error) {
          if (error instanceof ServiceValidationError) {
            return json(submission.reply({ formErrors: [error.message] }));
          }
          if (error instanceof AlertChannelChangedError) {
            return changed();
          }
          throw error;
        }
      }
    }

    if (emailEnabled) {
      for (const email of emails) {
        const options: CreateAlertChannelOptions = {
          name: `Error alert to ${email}`,
          alertTypes: ["ERROR_GROUP"],
          environmentTypes,
          deduplicationKey: `error-email:${email}:${environment.type}`,
          authorizedChannel: authorizedChannel(`error-email:${email}:${environment.type}`),
          channel: { type: "EMAIL", email },
        };
        try {
          await service.call(project.externalRef, userId, options);
        } catch (error) {
          if (error instanceof AlertChannelChangedError) {
            return changed();
          }
          throw error;
        }
      }
    }

    for (const url of webhooks) {
      const options: CreateAlertChannelOptions = {
        name: `Error alert to ${new URL(url).hostname}`,
        alertTypes: ["ERROR_GROUP"],
        environmentTypes,
        deduplicationKey: `error-webhook:${url}:${environment.type}`,
        authorizedChannel: authorizedChannel(`error-webhook:${url}:${environment.type}`),
        channel: { type: "WEBHOOK", url },
      };
      try {
        await service.call(project.externalRef, userId, options);
      } catch (error) {
        // CreateAlertChannelService rejects unsafe webhook URLs.
        if (error instanceof ServiceValidationError) {
          return json(submission.reply({ fieldErrors: { webhooks: [error.message] } }));
        }
        if (error instanceof AlertChannelChangedError) {
          return changed();
        }
        throw error;
      }
    }

    const deletePinned = async (id: string, types: RuntimeEnvironmentType[]) =>
      (
        await prisma.projectAlertChannel.deleteMany({
          where: { id, projectId: project.id, environmentTypes: { equals: types } },
        })
      ).count;
    for (const ch of channelsToDelete) {
      if (await deletePinned(ch.id, ch.environmentTypes)) continue;
      const current = await prisma.projectAlertChannel.findFirst({
        where: { id: ch.id, projectId: project.id },
        select: { environmentTypes: true },
      });
      if (!current) continue;
      requireAcrossEnvironments(ability, "delete", "alerts", current.environmentTypes);
      if (!(await deletePinned(ch.id, current.environmentTypes))) return changed();
    }

    return json({ ok: true });
  }
);

export default function Page() {
  const { alertData, connectToSlackHref, errorsPath } = useTypedLoaderData<typeof loader>();
  const { has } = useSearchParams();
  const showAlerts = has("alerts") ?? false;
  const navigate = useNavigate();
  const location = useOptimisticLocation();

  const closeAlerts = useCallback(() => {
    const params = new URLSearchParams(location.search);
    params.delete("alerts");
    const qs = params.toString();
    navigate(qs ? `?${qs}` : location.pathname, { replace: true });
  }, [location.search, location.pathname, navigate]);

  return (
    <PageContainer>
      <Outlet />

      <Sheet open={showAlerts} onOpenChange={(open) => !open && closeAlerts()}>
        <SheetContent
          side="right"
          className="w-[420px] min-w-[320px] max-w-[560px] p-0 sm:max-w-[560px]"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          {alertData ? (
            <ConfigureErrorAlerts
              {...alertData}
              connectToSlackHref={connectToSlackHref}
              formAction={errorsPath}
            />
          ) : (
            <div className="p-3">
              <Callout variant="warning">You don't have permission to view error alerts.</Callout>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </PageContainer>
  );
}
