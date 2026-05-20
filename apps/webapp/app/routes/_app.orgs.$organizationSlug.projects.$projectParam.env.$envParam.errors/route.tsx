import { parse } from "@conform-to/zod";
import { Outlet, useNavigate } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { useCallback } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageContainer } from "~/components/layout/AppLayout";
import {
  ConfigureErrorAlerts,
  ErrorAlertsFormSchema,
} from "~/components/errors/ConfigureErrorAlerts";
import { Sheet, SheetContent } from "~/components/primitives/SheetV3";
import { prisma } from "~/db.server";
import { ErrorAlertChannelPresenter } from "~/presenters/v3/ErrorAlertChannelPresenter.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { env } from "~/env.server";
import {
  EnvironmentParamSchema,
  v3ErrorsConnectToSlackPath,
  v3ErrorsPath,
} from "~/utils/pathBuilder";
import {
  type CreateAlertChannelOptions,
  CreateAlertChannelService,
} from "~/v3/services/alerts/createAlertChannel.server";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { useSearchParams } from "~/hooks/useSearchParam";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const presenter = new ErrorAlertChannelPresenter();
  const alertData = await presenter.call(project.id, environment.type);

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
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

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
  const submission = parse(formData, { schema: ErrorAlertsFormSchema });

  if (!submission.value) {
    return json(submission);
  }

  const { emails, webhooks, slackChannel, slackIntegrationId } = submission.value;

  const emailEnabled = env.ALERT_FROM_EMAIL !== undefined && env.ALERT_RESEND_API_KEY !== undefined;
  const slackEnabled = !!slackIntegrationId;

  const existingChannels = await prisma.projectAlertChannel.findMany({
    where: {
      projectId: project.id,
      alertTypes: { has: "ERROR_GROUP" },
      environmentTypes: { has: environment.type },
    },
  });

  const service = new CreateAlertChannelService();
  const environmentTypes = [environment.type];
  const processedChannelIds = new Set<string>();

  if (emailEnabled) {
    for (const email of emails) {
      const options: CreateAlertChannelOptions = {
        name: `Error alert to ${email}`,
        alertTypes: ["ERROR_GROUP"],
        environmentTypes,
        deduplicationKey: `error-email:${email}:${environment.type}`,
        channel: { type: "EMAIL", email },
      };
      const channel = await service.call(project.externalRef, userId, options);
      processedChannelIds.add(channel.id);
    }
  }

  if (slackEnabled && slackChannel) {
    const [channelId, channelName] = slackChannel.split("/");
    if (channelId && channelName) {
      const options: CreateAlertChannelOptions = {
        name: `Error alert to #${channelName}`,
        alertTypes: ["ERROR_GROUP"],
        environmentTypes,
        deduplicationKey: `error-slack:${environment.type}`,
        channel: {
          type: "SLACK",
          channelId,
          channelName,
          integrationId: slackIntegrationId,
        },
      };
      const channel = await service.call(project.externalRef, userId, options);
      processedChannelIds.add(channel.id);
    }
  }

  for (const url of webhooks) {
    const options: CreateAlertChannelOptions = {
      name: `Error alert to ${new URL(url).hostname}`,
      alertTypes: ["ERROR_GROUP"],
      environmentTypes,
      deduplicationKey: `error-webhook:${url}:${environment.type}`,
      channel: { type: "WEBHOOK", url },
    };
    const channel = await service.call(project.externalRef, userId, options);
    processedChannelIds.add(channel.id);
  }

  const editableTypes = new Set<string>(["WEBHOOK"]);
  if (emailEnabled) {
    editableTypes.add("EMAIL");
  }
  if (slackEnabled) {
    editableTypes.add("SLACK");
  }

  const channelsToDelete = existingChannels.filter(
    (ch) =>
      !processedChannelIds.has(ch.id) &&
      editableTypes.has(ch.type) &&
      ch.alertTypes.length === 1 &&
      ch.alertTypes[0] === "ERROR_GROUP"
  );

  for (const ch of channelsToDelete) {
    await prisma.projectAlertChannel.delete({ where: { id: ch.id } });
  }

  return json({ ok: true });
};

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
          <ConfigureErrorAlerts
            {...alertData}
            connectToSlackHref={connectToSlackHref}
            formAction={errorsPath}
          />
        </SheetContent>
      </Sheet>
    </PageContainer>
  );
}
