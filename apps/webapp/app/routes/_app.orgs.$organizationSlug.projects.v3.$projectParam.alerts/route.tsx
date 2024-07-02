import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  BellAlertIcon,
  BellSlashIcon,
  BookOpenIcon,
  EnvelopeIcon,
  GlobeAltIcon,
  LockClosedIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, Outlet, useActionData, useNavigation } from "@remix-run/react";
import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { SlackIcon } from "@trigger.dev/companyicons";
import { ProjectAlertChannelType, ProjectAlertType } from "@trigger.dev/database";
import assertNever from "assert-never";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { EnvironmentTypeLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DetailCell } from "~/components/primitives/DetailCell";
import { Header2 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import {
  AlertChannelListPresenter,
  AlertChannelListPresenterRecord,
} from "~/presenters/v3/AlertChannelListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  ProjectParamSchema,
  docsPath,
  v3NewProjectAlertPath,
  v3ProjectAlertsPath,
} from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug } = ProjectParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const presenter = new AlertChannelListPresenter();
  const data = await presenter.call(project.id);

  return typedjson(data);
};

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), id: z.string() }),
  z.object({ action: z.literal("disable"), id: z.string() }),
  z.object({ action: z.literal("enable"), id: z.string() }),
]);

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return json(submission);
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    submission.error.key = "Project not found";
    return json(submission);
  }

  switch (submission.value.action) {
    case "delete": {
      const alertChannel = await prisma.projectAlertChannel.delete({
        where: { id: submission.value.id, projectId: project.id },
      });

      return redirectWithSuccessMessage(
        v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }),
        request,
        `Deleted ${alertChannel.name} alert`
      );
    }
    case "disable": {
      const alertChannel = await prisma.projectAlertChannel.update({
        where: { id: submission.value.id, projectId: project.id },
        data: { enabled: false },
      });

      return redirectWithSuccessMessage(
        v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }),
        request,
        `Disabled ${alertChannel.name} alert`
      );
    }
    case "enable": {
      const alertChannel = await prisma.projectAlertChannel.update({
        where: { id: submission.value.id, projectId: project.id },
        data: { enabled: true },
      });

      return redirectWithSuccessMessage(
        v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }),
        request,
        `Enabled ${alertChannel.name} alert`
      );
    }
  }
};

export default function Page() {
  const { alertChannels } = useTypedLoaderData<typeof loader>();
  const project = useProject();
  const organization = useOrganization();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Alerts" />
        <PageAccessories>
          <LinkButton
            LeadingIcon={BookOpenIcon}
            to={docsPath("v3/troubleshooting-alerts")}
            variant="minimal/small"
          >
            Alerts docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody>
        <div className={cn("flex h-full flex-col gap-3")}>
          {alertChannels.length > 0 && alertChannels.length < 10 && (
            <div className="flex items-end justify-between">
              <Header2 className="">Project alerts</Header2>
              <LinkButton
                to={v3NewProjectAlertPath(organization, project)}
                variant="primary/small"
                LeadingIcon={PlusIcon}
                shortcut={{ key: "n" }}
              >
                New alert
              </LinkButton>
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Name</TableHeaderCell>
                <TableHeaderCell>Alert types</TableHeaderCell>
                <TableHeaderCell>Environments</TableHeaderCell>
                <TableHeaderCell>Channel</TableHeaderCell>
                <TableHeaderCell>Enabled</TableHeaderCell>
                <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {alertChannels.length > 0 ? (
                alertChannels.map((alertChannel) => (
                  <TableRow key={alertChannel.id}>
                    <TableCell className={alertChannel.enabled ? "" : "opacity-50"}>
                      {alertChannel.name}
                    </TableCell>
                    <TableCell className={alertChannel.enabled ? "" : "opacity-50"}>
                      {alertChannel.alertTypes.map((type) => alertTypeTitle(type)).join(", ")}
                    </TableCell>
                    <TableCell
                      className={cn("space-x-2", alertChannel.enabled ? "" : "opacity-50")}
                    >
                      {alertChannel.environmentTypes.map((environmentType) => (
                        <EnvironmentTypeLabel
                          key={environmentType}
                          environment={{ type: environmentType }}
                        />
                      ))}
                    </TableCell>
                    <TableCell className={alertChannel.enabled ? "" : "opacity-50"}>
                      <AlertChannelDetails alertChannel={alertChannel} />
                    </TableCell>
                    <TableCell className={alertChannel.enabled ? "" : "opacity-50"}>
                      <EnabledStatus
                        enabled={alertChannel.enabled}
                        enabledIcon={BellAlertIcon}
                        disabledIcon={BellSlashIcon}
                      />
                    </TableCell>
                    <TableCellMenu isSticky>
                      {alertChannel.enabled ? (
                        <DisableAlertChannelButton id={alertChannel.id} />
                      ) : (
                        <EnableAlertChannelButton id={alertChannel.id} />
                      )}

                      <DeleteAlertChannelButton id={alertChannel.id} />
                    </TableCellMenu>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={5}>
                    <div className="flex flex-col items-center justify-center py-6">
                      <Header2 spacing className="text-text-bright">
                        You haven't created any project alerts yet
                      </Header2>
                      <Paragraph variant="small" className="mb-4">
                        Get alerted when runs or deployments fail, or when deployments succeed in
                        both Prod and Staging environments.
                      </Paragraph>
                      <LinkButton
                        to={v3NewProjectAlertPath(organization, project)}
                        variant="primary/medium"
                        LeadingIcon={PlusIcon}
                        shortcut={{ key: "n" }}
                      >
                        New alert
                      </LinkButton>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <InfoPanel
            title="Platform alerts"
            icon={BellAlertIcon}
            to="https://status.trigger.dev/"
            buttonLabel="Subscribe"
          >
            <Paragraph variant="small">
              Subscribe to get email notifications when Trigger.dev creates, updates or resolves a
              platform incident.
            </Paragraph>
          </InfoPanel>
        </div>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}

function DeleteAlertChannelButton(props: { id: string }) {
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "delete";

  const [form, { id }] = useForm({
    id: "delete-alert-channel",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <Form method="post" {...form.props}>
      <input type="hidden" name="id" value={props.id} />
      <Button
        name="action"
        value="delete"
        type="submit"
        variant="small-menu-item"
        LeadingIcon={TrashIcon}
        leadingIconClassName="text-rose-500"
        className="text-xs"
      >
        {isLoading ? "Deleting" : "Delete"}
      </Button>
    </Form>
  );
}

function DisableAlertChannelButton(props: { id: string }) {
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "delete";

  const [form, { id }] = useForm({
    id: "disable-alert-channel",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <Form method="post" {...form.props}>
      <input type="hidden" name="id" value={props.id} />

      <Button
        name="action"
        value="disable"
        type="submit"
        variant="small-menu-item"
        LeadingIcon={BellSlashIcon}
        leadingIconClassName="text-dimmed"
        className="text-xs"
      >
        {isLoading ? "Disabling" : "Disable"}
      </Button>
    </Form>
  );
}

function EnableAlertChannelButton(props: { id: string }) {
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "delete";

  const [form, { id }] = useForm({
    id: "enable-alert-channel",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <Form method="post" {...form.props}>
      <input type="hidden" name="id" value={props.id} />

      <Button
        name="action"
        value="enable"
        type="submit"
        variant="small-menu-item"
        LeadingIcon={BellAlertIcon}
        leadingIconClassName="text-success"
        className="text-xs"
      >
        {isLoading ? "Enabling" : "Enable"}
      </Button>
    </Form>
  );
}

function AlertChannelDetails({ alertChannel }: { alertChannel: AlertChannelListPresenterRecord }) {
  switch (alertChannel.properties?.type) {
    case "EMAIL": {
      return (
        <DetailCell
          leadingIcon={
            <AlertChannelTypeIcon
              channelType={alertChannel.type}
              className="size-5 text-charcoal-400"
            />
          }
          leadingIconClassName="text-charcoal-400"
          label={"Email"}
          description={alertChannel.properties.email}
        />
      );
    }
    case "WEBHOOK": {
      return (
        <DetailCell
          leadingIcon={
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger>
                  <AlertChannelTypeIcon
                    channelType={alertChannel.type}
                    className="size-5 text-charcoal-400"
                  />
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-1">Webhook</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          }
          leadingIconClassName="text-charcoal-400"
          label={alertChannel.properties.url}
          description={
            <ClipboardField
              value={alertChannel.properties.secret}
              variant="secondary/small"
              icon={<LockClosedIcon className="size-4" />}
              iconButton
              secure={"•".repeat(alertChannel.properties.secret.length)}
              className="mt-1 w-80"
            />
          }
        />
      );
    }
    case "SLACK": {
      return (
        <DetailCell
          leadingIcon={
            <AlertChannelTypeIcon
              channelType={alertChannel.type}
              className="size-5 text-charcoal-400"
            />
          }
          leadingIconClassName="text-charcoal-400"
          label={"Slack"}
          description={`#${alertChannel.properties.channelName}`}
        />
      );
    }
  }

  return null;
}

export function alertTypeTitle(alertType: ProjectAlertType): string {
  switch (alertType) {
    case "TASK_RUN_ATTEMPT":
      return "Task attempt failure";
    case "DEPLOYMENT_FAILURE":
      return "Deployment failure";
    case "DEPLOYMENT_SUCCESS":
      return "Deployment success";
    default: {
      assertNever(alertType);
    }
  }
}

export function AlertChannelTypeIcon({
  channelType,
  className,
}: {
  channelType: ProjectAlertChannelType;
  className: string;
}) {
  switch (channelType) {
    case "EMAIL":
      return <EnvelopeIcon className={className} />;
    case "SLACK":
      return <SlackIcon className={className} />;
    case "WEBHOOK":
      return <GlobeAltIcon className={className} />;
    default: {
      assertNever(channelType);
    }
  }
}
