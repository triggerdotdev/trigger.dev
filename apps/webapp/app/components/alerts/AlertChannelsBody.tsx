import { getFormProps, useForm, type SubmissionResult } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import {
  BellAlertIcon,
  BellSlashIcon,
  ChevronDownIcon,
  EnvelopeIcon,
  LockClosedIcon,
  PencilSquareIcon,
  PlusIcon,
} from "@heroicons/react/20/solid";
import { TrashIcon } from "~/assets/icons/TrashIcon";
import {
  Form,
  useActionData,
  useNavigation,
  useSearchParams,
  type FetcherWithComponents,
} from "@remix-run/react";
import { SlackIcon } from "@trigger.dev/companyicons";
import type { ProjectAlertChannelType, ProjectAlertType } from "@trigger.dev/database";
import assertNever from "assert-never";
import { useState } from "react";
import { z } from "zod";
import { AddChannelSection } from "~/components/alerts/AddChannelSection";
import type { AlertChannelForm } from "~/components/alerts/AlertChannelForm";
import { EditChannelDialog } from "~/components/alerts/EditChannelDialog";
import { GlobeLinesIcon } from "~/assets/icons/GlobeLinesIcon";
import { AlertsNoneDev, AlertsNoneDeployed } from "~/components/alerts/AlertsBlankStates";
import { EnvironmentIcon, EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Feedback } from "~/components/Feedback";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { DetailCell } from "~/components/primitives/DetailCell";
import { Header3 } from "~/components/primitives/Headers";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
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
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import type { AlertChannelListPresenterRecord } from "~/presenters/v3/AlertChannelListPresenter.server";
import { cn } from "~/utils/cn";
import { v3BillingPath } from "~/utils/pathBuilder";

export const alertChannelActionSchema = z.object({
  action: z.enum(["delete", "disable", "enable", "update"]),
  id: z.string(),
  environmentTypes: z.array(z.enum(["PRODUCTION", "STAGING", "DEVELOPMENT", "PREVIEW"])).optional(),
});

export type ChannelsModal = {
  action: string;
  redirectTo: string;
  fetcher: FetcherWithComponents<unknown>;
  reload: () => void;
  onCreated?: (channel: { id: string }) => void;
  connectReturnTo?: string;
  onConnect?: () => void;
  addSlack?: boolean;
};

export type ChannelFormState = Pick<
  React.ComponentProps<typeof AlertChannelForm>,
  "slack" | "emailAlertsEnabled"
>;

export type AlertChannelRow = Omit<
  AlertChannelListPresenterRecord,
  "createdAt" | "updatedAt" | "properties"
> & {
  properties?: AlertChannelListPresenterRecord["properties"];
  canWrite?: boolean;
  canDelete?: boolean;
};

export type AlertChannelLimits = { used: number; limit: number };

export function AlertChannelsBody({
  alertChannels,
  limits,
  canWrite,
  canDelete,
  modal,
  form,
}: {
  alertChannels: AlertChannelRow[];
  limits: AlertChannelLimits;
  canWrite: boolean;
  canDelete?: boolean;
  modal?: ChannelsModal;
  form?: ChannelFormState;
}) {
  const organization = useOrganization();
  const environment = useEnvironment();
  const showSelfServe = useShowSelfServe();
  const [editingId, setEditingId] = useState<string | undefined>();
  const [searchParams] = useSearchParams();
  const addSlack = modal?.addSlack ?? searchParams.get("add") === "slack";
  const [adding, setAdding] = useState(addSlack);
  const editing = alertChannels.find((channel) => channel.id === editingId);

  const requiresUpgrade = limits.used >= limits.limit;
  const showAddChannel = Boolean(modal && form && canWrite && !requiresUpgrade);
  const showForm = adding || alertChannels.length === 0;

  if (alertChannels.length === 0 && !(modal && form)) {
    return (
      <MainCenteredContainer className="max-w-md">
        {environment.type === "DEVELOPMENT" ? <AlertsNoneDev /> : <AlertsNoneDeployed />}
      </MainCenteredContainer>
    );
  }

  return (
    <div className="grid max-h-full min-h-full grid-rows-[1fr_auto]">
      <div>
        {alertChannels.length > 0 && !showForm && (
          <Table
            showTopBorder={!modal}
            containerClassName={modal ? "overflow-x-hidden" : undefined}
          >
            <TableBody>
              {alertChannels.map((alertChannel) => (
                <TableRow key={alertChannel.id}>
                  <TableCell
                    className={cn("min-w-0 py-1", alertChannel.enabled ? "" : "opacity-50")}
                  >
                    <AlertChannelDetails alertChannel={alertChannel} />
                  </TableCell>
                  <TableCell
                    className={cn(
                      "w-px whitespace-nowrap",
                      alertChannel.enabled ? "" : "opacity-50"
                    )}
                  >
                    <EnabledStatus
                      enabled={alertChannel.enabled}
                      enabledIcon={BellAlertIcon}
                      disabledIcon={BellSlashIcon}
                    />
                  </TableCell>
                  <TableCell
                    className={cn(
                      "w-px whitespace-nowrap",
                      alertChannel.enabled ? "" : "opacity-50"
                    )}
                  >
                    <EnvironmentsCell environmentTypes={alertChannel.environmentTypes} />
                  </TableCell>
                  <TableCellMenu
                    isSticky
                    popoverContent={
                      <>
                        {modal && form && (
                          <Button
                            type="button"
                            onClick={() => setEditingId(alertChannel.id)}
                            disabled={!(alertChannel.canWrite ?? canWrite)}
                            fullWidth
                            textAlignLeft
                            variant="small-menu-item"
                            LeadingIcon={PencilSquareIcon}
                            leadingIconClassName="text-text-dimmed"
                            className="text-xs"
                          >
                            Edit
                          </Button>
                        )}
                        {alertChannel.enabled ? (
                          <DisableAlertChannelButton
                            id={alertChannel.id}
                            disabled={!(alertChannel.canWrite ?? canWrite)}
                            modal={modal}
                          />
                        ) : (
                          <EnableAlertChannelButton
                            id={alertChannel.id}
                            disabled={!(alertChannel.canWrite ?? canWrite)}
                            modal={modal}
                          />
                        )}
                        <DeleteAlertChannelButton
                          id={alertChannel.id}
                          disabled={
                            !(
                              (alertChannel.canWrite ?? canWrite) &&
                              (alertChannel.canDelete ?? canDelete)
                            )
                          }
                          modal={modal}
                        />
                      </>
                    }
                    className={cn(
                      "w-10 pl-2",
                      !alertChannel.enabled && "group-hover/table-row:bg-background-bright/50"
                    )}
                  />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {showAddChannel && form && modal && !showForm && (
          <div className="border-t border-grid-bright p-4">
            <Button
              type="button"
              variant="secondary/small"
              LeadingIcon={PlusIcon}
              onClick={() => setAdding(true)}
            >
              Add channel
            </Button>
          </div>
        )}
        {showAddChannel && form && modal && showForm && (
          <AddChannelSection
            form={form}
            defaultType={addSlack ? "SLACK" : "EMAIL"}
            connectReturnTo={modal.connectReturnTo}
            onConnect={modal.onConnect}
            onCreated={(channel) => {
              setAdding(false);
              modal.reload();
              modal.onCreated?.(channel);
            }}
          />
        )}
      </div>
      {editing && form && modal && (
        <EditChannelDialog
          channel={editing}
          form={form}
          action={modal.action}
          redirectTo={modal.redirectTo}
          onClose={() => setEditingId(undefined)}
        />
      )}
      <div className="flex h-fit items-stretch gap-3">
        <div className="flex w-full items-start justify-between">
          <div className="flex h-fit w-full items-center gap-4 border-t border-grid-bright bg-background-bright p-[0.86rem] pl-4">
            <SimpleTooltip
              disableHoverableContent
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
                      className={`fill-none ${requiresUpgrade ? "stroke-error" : "stroke-success"}`}
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
                  You've used all {limits.limit} of your available alerts. Upgrade your plan to
                  enable more.
                </Header3>
              ) : (
                <Header3>
                  {limits.limit >= 1_000_000
                    ? `You've used ${limits.used} alerts.`
                    : `You've used ${limits.used}/${limits.limit} of your alerts.`}
                </Header3>
              )}

              {showSelfServe ? (
                <LinkButton to={v3BillingPath(organization)} variant="secondary/small">
                  Upgrade
                </LinkButton>
              ) : (
                <Feedback
                  defaultValue="enterprise"
                  button={<Button variant="secondary/small">Request more</Button>}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DeleteAlertChannelButton(props: { id: string; disabled: boolean; modal?: ChannelsModal }) {
  const actionData = useActionData();
  const lastSubmission = props.modal?.fetcher.data ?? actionData;
  const FormEl = props.modal?.fetcher.Form ?? Form;
  const navigation = useNavigation();
  const submitting = props.modal?.fetcher ?? navigation;

  const isLoading =
    submitting.state !== "idle" &&
    submitting.formMethod === "post" &&
    submitting.formData?.get("action") === "delete";

  const [form] = useForm({
    id: "delete-alert-channel",
    lastResult: lastSubmission as SubmissionResult<string[]> | undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: alertChannelActionSchema });
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <FormEl method="post" action={props.modal?.action} {...getFormProps(form)}>
      {props.modal && <input type="hidden" name="redirectTo" value={props.modal.redirectTo} />}
      <input type="hidden" name="id" value={props.id} />
      <Button
        name="action"
        value="delete"
        fullWidth
        textAlignLeft
        type="submit"
        disabled={props.disabled}
        variant="small-menu-item"
        LeadingIcon={TrashIcon}
        leadingIconClassName="text-rose-500"
        className="text-xs"
      >
        {isLoading ? "Deleting" : "Delete"}
      </Button>
    </FormEl>
  );
}

function DisableAlertChannelButton(props: {
  id: string;
  disabled: boolean;
  modal?: ChannelsModal;
}) {
  const actionData = useActionData();
  const lastSubmission = props.modal?.fetcher.data ?? actionData;
  const FormEl = props.modal?.fetcher.Form ?? Form;
  const navigation = useNavigation();
  const submitting = props.modal?.fetcher ?? navigation;

  const isLoading =
    submitting.state !== "idle" &&
    submitting.formMethod === "post" &&
    submitting.formData?.get("action") === "disable";

  const [form] = useForm({
    id: "disable-alert-channel",
    lastResult: lastSubmission as SubmissionResult<string[]> | undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: alertChannelActionSchema });
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <FormEl method="post" action={props.modal?.action} {...getFormProps(form)}>
      {props.modal && <input type="hidden" name="redirectTo" value={props.modal.redirectTo} />}
      <input type="hidden" name="id" value={props.id} />

      <Button
        name="action"
        value="disable"
        type="submit"
        disabled={props.disabled}
        fullWidth
        textAlignLeft
        variant="small-menu-item"
        LeadingIcon={BellSlashIcon}
        leadingIconClassName="text-dimmed"
        className="text-xs"
      >
        {isLoading ? "Disabling" : "Disable"}
      </Button>
    </FormEl>
  );
}

function EnableAlertChannelButton(props: { id: string; disabled: boolean; modal?: ChannelsModal }) {
  const actionData = useActionData();
  const lastSubmission = props.modal?.fetcher.data ?? actionData;
  const FormEl = props.modal?.fetcher.Form ?? Form;
  const navigation = useNavigation();
  const submitting = props.modal?.fetcher ?? navigation;

  const isLoading =
    submitting.state !== "idle" &&
    submitting.formMethod === "post" &&
    submitting.formData?.get("action") === "enable";

  const [form] = useForm({
    id: "enable-alert-channel",
    lastResult: lastSubmission as SubmissionResult<string[]> | undefined,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: alertChannelActionSchema });
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <FormEl method="post" action={props.modal?.action} {...getFormProps(form)}>
      {props.modal && <input type="hidden" name="redirectTo" value={props.modal.redirectTo} />}
      <input type="hidden" name="id" value={props.id} />

      <Button
        name="action"
        value="enable"
        type="submit"
        disabled={props.disabled}
        fullWidth
        textAlignLeft
        variant="small-menu-item"
        LeadingIcon={BellAlertIcon}
        leadingIconClassName="text-success"
        className="text-xs"
      >
        {isLoading ? "Enabling" : "Enable"}
      </Button>
    </FormEl>
  );
}

function AlertChannelDetails({ alertChannel }: { alertChannel: AlertChannelRow }) {
  switch (alertChannel.properties?.type) {
    case "EMAIL": {
      return (
        <DetailCell
          leadingIcon={
            <AlertChannelTypeIcon
              channelType={alertChannel.type}
              className="size-5 text-text-dimmed"
            />
          }
          leadingIconClassName="text-text-dimmed"
          label={"Email"}
          description={alertChannel.properties.email}
          boxClassName="group-hover/table-row:bg-background-bright"
          className="h-auto"
        />
      );
    }
    case "WEBHOOK": {
      return (
        <DetailCell
          leadingIcon={
            <TooltipProvider disableHoverableContent>
              <Tooltip>
                <TooltipTrigger>
                  <AlertChannelTypeIcon
                    channelType={alertChannel.type}
                    className="size-5 text-text-dimmed"
                  />
                </TooltipTrigger>
                <TooltipContent className="flex items-center gap-1">Webhook</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          }
          leadingIconClassName="text-text-dimmed"
          label={
            <span className="block max-w-80 truncate text-xs">{alertChannel.properties.url}</span>
          }
          description={
            alertChannel.properties.secret ? (
              <ClipboardField
                value={alertChannel.properties.secret}
                variant="secondary/small"
                icon={<LockClosedIcon className="size-4" />}
                iconButton
                secure={"•".repeat(alertChannel.properties.secret.length)}
                className="mt-1 w-full max-w-80"
              />
            ) : undefined
          }
          boxClassName="group-hover/table-row:bg-background-bright"
          className="h-auto"
        />
      );
    }
    case "SLACK": {
      return (
        <DetailCell
          leadingIcon={
            <AlertChannelTypeIcon
              channelType={alertChannel.type}
              className="size-5 text-text-dimmed"
            />
          }
          leadingIconClassName="text-text-dimmed"
          label={"Slack"}
          description={`#${alertChannel.properties.channelName}`}
          boxClassName="group-hover/table-row:bg-background-bright"
          className="h-auto"
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
    case "ERROR_GROUP":
      return "Error group";
    case "DASHBOARD_AGENT_WATCH":
      return "Dashboard agent watches";
    default: {
      throw new Error(`Unknown alertType: ${alertType}`);
    }
  }
}

function AlertChannelTypeIcon({
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
      return <GlobeLinesIcon className={className} />;
    default: {
      assertNever(channelType);
    }
  }
}

function EnvironmentsCell({
  environmentTypes,
}: {
  environmentTypes: AlertChannelListPresenterRecord["environmentTypes"];
}) {
  if (environmentTypes.length === 1) {
    return <EnvironmentRow environmentType={environmentTypes[0]} />;
  }
  return (
    <Popover>
      <PopoverTrigger className="flex items-center gap-1.5 whitespace-nowrap text-xs text-text-dimmed transition hover:text-text-bright focus-custom">
        <span className="flex items-center gap-0.5">
          {environmentTypes.map((environmentType) => (
            <EnvironmentIcon
              key={environmentType}
              environment={{ type: environmentType }}
              className="size-4.5 shrink-0"
            />
          ))}
        </span>
        <span>
          {environmentTypes.length} {environmentTypes.length === 1 ? "environment" : "environments"}
        </span>
        <ChevronDownIcon className="size-4 text-text-dimmed" />
      </PopoverTrigger>
      <PopoverContent align="start" className="flex flex-col gap-1.5 p-2">
        {environmentTypes.map((environmentType) => (
          <EnvironmentRow key={environmentType} environmentType={environmentType} />
        ))}
      </PopoverContent>
    </Popover>
  );
}

function EnvironmentRow({
  environmentType,
}: {
  environmentType: AlertChannelListPresenterRecord["environmentTypes"][number];
}) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-text-bright">
      <EnvironmentIcon environment={{ type: environmentType }} className="size-4.5 shrink-0" />
      <EnvironmentLabel environment={{ type: environmentType }} truncate={false} disableTooltip />
    </span>
  );
}
