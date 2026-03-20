import { parse } from "@conform-to/zod";
import { Outlet, useSearchParams } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageContainer } from "~/components/layout/AppLayout";
import {
  ConfigureErrorAlerts,
  ErrorAlertsFormSchema,
} from "~/components/errors/ConfigureErrorAlerts";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "~/components/primitives/Resizable";
import { prisma } from "~/db.server";
import { ErrorAlertChannelPresenter } from "~/presenters/v3/ErrorAlertChannelPresenter.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, v3ErrorsConnectToSlackPath } from "~/utils/pathBuilder";
import {
  type CreateAlertChannelOptions,
  CreateAlertChannelService,
} from "~/v3/services/alerts/createAlertChannel.server";

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

  return typedjson({
    alertData,
    projectRef: project.externalRef,
    projectId: project.id,
    environmentType: environment.type,
    connectToSlackHref,
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

  if (slackChannel) {
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

  const channelsToDelete = existingChannels.filter(
    (ch) =>
      !processedChannelIds.has(ch.id) &&
      ch.alertTypes.length === 1 &&
      ch.alertTypes[0] === "ERROR_GROUP"
  );

  for (const ch of channelsToDelete) {
    await prisma.projectAlertChannel.delete({ where: { id: ch.id } });
  }

  return json({ ok: true });
};

export default function Page() {
  const { alertData, connectToSlackHref } = useTypedLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  const showAlerts = searchParams.has("alerts");

  return (
    <PageContainer>
      <ResizablePanelGroup orientation="horizontal" className="h-full overflow-hidden">
        <ResizablePanel id="errors-main" min="300px">
          <Outlet />
        </ResizablePanel>
        {showAlerts && (
          <>
            <ResizableHandle id="errors-alerts-handle" />
            <ResizablePanel id="errors-alerts" min="320px" default="420px" max="560px">
              <ConfigureErrorAlerts {...alertData} connectToSlackHref={connectToSlackHref} />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </PageContainer>
  );
}
