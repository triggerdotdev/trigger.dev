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
import { Form, type MetaFunction, Outlet, useActionData, useNavigation } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { SlackIcon } from "@trigger.dev/companyicons";
import { type ProjectAlertChannelType, type ProjectAlertType } from "@trigger.dev/database";
import assertNever from "assert-never";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { AlertsNoneDev, AlertsNoneDeployed } from "~/components/BlankStatePanels";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { MainCenteredContainer, PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DetailCell } from "~/components/primitives/DetailCell";
import { Header2, Header3 } from "~/components/primitives/Headers";
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
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { EnabledStatus } from "~/components/runs/v3/EnabledStatus";
import { prisma } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  AlertChannelListPresenter,
  type AlertChannelListPresenterRecord,
} from "~/presenters/v3/AlertChannelListPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  docsPath,
  v3BillingPath,
  v3NewProjectAlertPath,
  v3ProjectAlertsPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Alerts | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const presenter = new AlertChannelListPresenter();
  const data = await presenter.call(project.id, environment.type);

  return typedjson(data);
};

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("delete"), id: z.string() }),
  z.object({ action: z.literal("disable"), id: z.string() }),
  z.object({ action: z.literal("enable"), id: z.string() }),
]);

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

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
    submission.error.key = ["Project not found"];
    return json(submission);
  }

  switch (submission.value.action) {
    case "delete": {
      const alertChannel = await prisma.projectAlertChannel.delete({
        where: { id: submission.value.id, projectId: project.id },
      });

      return redirectWithSuccessMessage(
        v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
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
        v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
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
        v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
        request,
        `Enabled ${alertChannel.name} alert`
      );
    }
  }
};

export default function Page() {
  const { alertChannels, limits } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const requiresUpgrade = limits.used >= limits.limit;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Alerts" />
        <PageAccessories>
          <LinkButton
            LeadingIcon={BookOpenIcon}
            to={docsPath("v3/troubleshooting-alerts")}
            variant="docs/small"
          >
            Alerts docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        {alertChannels.length > 0 ? (
          <div className="grid max-h-full min-h-full grid-rows-[auto_1fr_auto]">
            <div className="flex h-fit items-end justify-between p-2 pl-3">
              <Header2 className="">Project alerts</Header2>
              {alertChannels.length > 0 && !requiresUpgrade && (
                <LinkButton
                  to={v3NewProjectAlertPath(organization, project, environment)}
                  variant="primary/small"
                  LeadingIcon={PlusIcon}
                  shortcut={{ key: "n" }}
                >
                  New alert
                </LinkButton>
              )}
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Name</TableHeaderCell>
                  <TableHeaderCell>Alert types</TableHeaderCell>
                  <TableHeaderCell>Channel</TableHeaderCell>
                  <TableHeaderCell>Enabled</TableHeaderCell>
                  <TableHeaderCell>Environments</TableHeaderCell>
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
                      <TableCell className={cn("py-1", alertChannel.enabled ? "" : "opacity-50")}>
                        <AlertChannelDetails alertChannel={alertChannel} />
                      </TableCell>
                      <TableCell className={alertChannel.enabled ? "" : "opacity-50"}>
                        <EnabledStatus
                          enabled={alertChannel.enabled}
                          enabledIcon={BellAlertIcon}
                          disabledIcon={BellSlashIcon}
                        />
                      </TableCell>
                      <TableCell className={alertChannel.enabled ? "" : "opacity-50"}>
                        <div className="flex items-center gap-3">
                          {alertChannel.environmentTypes.map((environmentType) => (
                            <EnvironmentCombo
                              key={environmentType}
                              environment={{ type: environmentType }}
                              className="text-xs"
                            />
                          ))}
                        </div>
                      </TableCell>
                      <TableCellMenu
                        isSticky
                        popoverContent={
                          <>
                            {alertChannel.enabled ? (
                              <DisableAlertChannelButton id={alertChannel.id} />
                            ) : (
                              <EnableAlertChannelButton id={alertChannel.id} />
                            )}
                            <DeleteAlertChannelButton id={alertChannel.id} />
                          </>
                        }
                        className={
                          alertChannel.enabled ? "" : "group-hover/table-row:bg-charcoal-800/50"
                        }
                      />
                    </TableRow>
                  ))
                ) : (
                  <TableRow>
                    <TableCell colSpan={6}>
                      <div className="flex flex-col items-center justify-center py-6">
                        <Header2 spacing className="text-text-bright">
                          You haven't created any project alerts yet
                        </Header2>
                        <Paragraph variant="small" className="mb-4">
                          Get alerted when runs or deployments fail, or when deployments succeed in
                          both Prod and Staging environments.
                        </Paragraph>
                        <LinkButton
                          to={v3NewProjectAlertPath(organization, project, environment)}
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
            <div className="flex h-fit items-stretch gap-3">
              <div className="flex w-full items-start justify-between">
                <div className="flex h-fit w-full items-center gap-4 border-t border-grid-bright bg-background-bright p-[0.86rem] pl-4">
                  <SimpleTooltip
                    button={
                      <div className="size-6">
                        <svg className="h-full w-full -rotate-90 overflow-visible">
                          <circle
                            className="fill-none stroke-grid-bright"
                            strokeWidth="4"
                            r="10"
                            cx="12"
                            cy="12"
                          />
                          <circle
                            className={`fill-none ${
                              requiresUpgrade ? "stroke-error" : "stroke-success"
                            }`}
                            strokeWidth="4"
                            r="10"
                            cx="12"
                            cy="12"
                            strokeDasharray={`${(limits.used / limits.limit) * 62.8} 62.8`}
                            strokeDashoffset="0"
                            strokeLinecap="round"
                          />
                        </svg>
                      </div>
                    }
                    content={`${Math.round((limits.used / limits.limit) * 100)}%`}
                  />
                  <div className="flex w-full items-center justify-between gap-6">
                    {requiresUpgrade ? (
                      <Header3 className="text-error">
                        You've used all {limits.limit} of your available alerts. Upgrade your plan
                        to enable more.
                      </Header3>
                    ) : (
                      <Header3>
                        You've used {limits.used}/{limits.limit} of your alerts.
                      </Header3>
                    )}

                    <LinkButton to={v3BillingPath(organization)} variant="secondary/small">
                      Upgrade
                    </LinkButton>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ) : environment.type === "DEVELOPMENT" ? (
          <MainCenteredContainer className="max-w-md">
            <AlertsNoneDev />
          </MainCenteredContainer>
        ) : (
          <MainCenteredContainer className="max-w-md">
            <AlertsNoneDeployed />
          </MainCenteredContainer>
        )}
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
        fullWidth
        textAlignLeft
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
        fullWidth
        textAlignLeft
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
        fullWidth
        textAlignLeft
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
          boxClassName="group-hover/table-row:bg-charcoal-800"
          className="h-12"
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
          boxClassName="group-hover/table-row:bg-charcoal-800"
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
          boxClassName="group-hover/table-row:bg-charcoal-800"
        />
      );
    }
  }

  return null;
}

export function alertTypeTitle(alertType: ProjectAlertType): string {
  switch (alertType) {
    case "TASK_RUN":
      return "Task run failure";
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
