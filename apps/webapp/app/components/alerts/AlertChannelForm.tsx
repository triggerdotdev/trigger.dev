import {
  getFormProps,
  getInputProps,
  getSelectProps,
  useForm,
  type SubmissionResult,
} from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import { HashtagIcon, LockClosedIcon } from "@heroicons/react/20/solid";
import {
  Form,
  type FetcherWithComponents,
  useActionData,
  useNavigate,
  useNavigation,
} from "@remix-run/react";
import { SlackIcon } from "@trigger.dev/companyicons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout, variantClasses } from "~/components/primitives/Callout";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { Select, SelectItem } from "~/components/primitives/Select";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import type { NewAlertChannelPresenter } from "~/presenters/v3/NewAlertChannelPresenter.server";
import { cn } from "~/utils/cn";
import {
  v3NewProjectAlertPathConnectToSlackPath,
  v3ProjectAlertChannelsPath,
} from "~/utils/pathBuilder";
import type { CreateAlertChannelOptions } from "~/v3/services/alerts/createAlertChannel.server";

export type AlertChannelFormType = "EMAIL" | "SLACK" | "WEBHOOK";

type SlackChannel = { id?: string; name?: string; is_private?: boolean };

type SlackState = Awaited<ReturnType<NewAlertChannelPresenter["call"]>>["slack"];

function renderSlackChannel(channels: SlackChannel[], value: string | string[]) {
  if (typeof value !== "string") return;
  const channel = channels.find((channel) => value === `${channel.id}/${channel.name}`);
  return channel ? <SlackChannelTitle {...channel} /> : undefined;
}

export const AlertChannelFormSchema = z
  .object({
    type: z.enum(["WEBHOOK", "SLACK", "EMAIL"]).default("EMAIL"),
    channelValue: z.string().nonempty(),
    integrationId: z.string().optional(),
  })
  .refine(
    (value) =>
      value.type === "EMAIL" ? z.string().email().safeParse(value.channelValue).success : true,
    {
      message: "Must be a valid email address",
      path: ["channelValue"],
    }
  )
  .refine(
    (value) =>
      value.type === "WEBHOOK" ? z.string().url().safeParse(value.channelValue).success : true,
    {
      message: "Must be a valid URL",
      path: ["channelValue"],
    }
  )
  .refine(
    (value) =>
      value.type === "SLACK"
        ? typeof value.channelValue === "string" && value.channelValue.startsWith("C")
        : true,
    {
      message: "Must select a Slack channel",
      path: ["channelValue"],
    }
  );

export function formDataToAlertChannel(
  formData: z.infer<typeof AlertChannelFormSchema>
): Pick<CreateAlertChannelOptions, "name" | "channel"> {
  switch (formData.type) {
    case "WEBHOOK": {
      return {
        name: `Webhook to ${new URL(formData.channelValue).hostname}`,
        channel: {
          type: "WEBHOOK",
          url: formData.channelValue,
        },
      };
    }
    case "EMAIL": {
      return {
        name: `Email to ${formData.channelValue}`,
        channel: {
          type: "EMAIL",
          email: formData.channelValue,
        },
      };
    }
    case "SLACK": {
      const [channelId, channelName] = formData.channelValue.split("/");

      return {
        name: `Slack message to ${channelName}`,
        channel: {
          type: "SLACK",
          channelId,
          channelName,
          integrationId: formData.integrationId,
        },
      };
    }
  }
}

const typeOptions = [
  { label: "Email", value: "EMAIL" },
  { label: "Slack", value: "SLACK" },
  { label: "Webhook", value: "WEBHOOK" },
];

export function AlertChannelForm({
  mode,
  slack,
  emailAlertsEnabled,
  defaultType,
  defaultChannelValue,
  fetcher,
  action,
  onClose,
  inline = false,
  intent,
  extraFields,
  submitDisabled = false,
  connectReturnTo,
  onConnect,
}: {
  mode: "create" | "edit";
  slack: SlackState;
  emailAlertsEnabled: boolean;
  defaultType: AlertChannelFormType;
  defaultChannelValue?: string;
  fetcher?: FetcherWithComponents<unknown>;
  action?: string;
  onClose?: () => void;
  inline?: boolean;
  intent?: string;
  extraFields?: ReactNode;
  submitDisabled?: boolean;
  connectReturnTo?: string;
  onConnect?: () => void;
}) {
  const actionData = useActionData();
  const fetcherData = fetcher?.data as { status?: string } | undefined;
  const lastSubmission = fetcher ? (fetcherData?.status ? fetcherData : undefined) : actionData;
  const navigation = useNavigation();
  const navigate = useNavigate();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const connectToSlackPath = v3NewProjectAlertPathConnectToSlackPath(
    organization,
    project,
    environment
  );
  const returnToParam = connectReturnTo ? `returnTo=${encodeURIComponent(connectReturnTo)}` : "";
  const [currentAlertChannel, setCurrentAlertChannel] = useState<string | null>(defaultType);
  const formRef = useRef<HTMLFormElement>(null);

  const [selectedSlackChannelValue, setSelectedSlackChannelValue] = useState<string | undefined>(
    defaultType === "SLACK" ? defaultChannelValue : undefined
  );

  const selectedSlackChannel = slack.channels?.find(
    (s) => selectedSlackChannelValue === `${s.id}/${s.name}`
  );

  const isLoading = fetcher
    ? fetcher.state !== "idle"
    : navigation.state !== "idle" &&
      navigation.formMethod === "post" &&
      navigation.formData?.get("action") === mode;
  const idle = fetcher ? fetcher.state === "idle" : navigation.state === "idle";
  const FormElement = fetcher ? fetcher.Form : Form;
  const close = () =>
    onClose ? onClose() : navigate(v3ProjectAlertChannelsPath(organization, project, environment));

  const [form, { channelValue, type, integrationId: _integrationId }] = useForm({
    id: `${mode}-alert`,
    lastResult: lastSubmission as SubmissionResult<string[]> | undefined,
    defaultValue: { type: defaultType, channelValue: defaultChannelValue },
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: AlertChannelFormSchema });
    },
    shouldRevalidate: "onSubmit",
  });

  useEffect(() => {
    if (!idle) return;
    if (lastSubmission !== undefined) return;

    formRef.current?.reset();
  }, [idle, lastSubmission]);

  const formElement = (
    <FormElement ref={formRef} method="post" action={action} {...getFormProps(form)}>
      <Fieldset className="mt-2">
        <InputGroup fullWidth>
          <SegmentedControl
            {...getInputProps(type, { type: "text" })}
            options={
              mode === "edit"
                ? typeOptions.filter((option) => option.value === defaultType)
                : typeOptions
            }
            onChange={(value) => {
              setCurrentAlertChannel(value);
            }}
            fullWidth
            defaultValue={currentAlertChannel ?? undefined}
          />
        </InputGroup>

        {currentAlertChannel === "EMAIL" ? (
          emailAlertsEnabled || mode === "edit" ? (
            <InputGroup fullWidth>
              <Label>Email</Label>
              <Input
                {...getInputProps(channelValue, { type: "text" })}
                placeholder="email@youremail.com"
                type="email"
                autoFocus={!inline}
              />
              <FormError id={channelValue.errorId}>{channelValue.errors}</FormError>
            </InputGroup>
          ) : (
            <Callout variant="warning">
              Email integration is not available. Please contact your organization administrator.
            </Callout>
          )
        ) : currentAlertChannel === "SLACK" ? (
          <InputGroup fullWidth>
            {slack.status === "READY" ? (
              <>
                <Select
                  {...getSelectProps(channelValue)}
                  placeholder="Select a Slack channel"
                  heading="Filter channels…"
                  defaultValue={defaultType === "SLACK" ? defaultChannelValue : undefined}
                  dropdownIcon
                  variant="tertiary/medium"
                  items={slack.channels}
                  setValue={(value) => {
                    typeof value === "string" && setSelectedSlackChannelValue(value);
                  }}
                  filter={(channel, search) =>
                    channel.name?.toLowerCase().includes(search.toLowerCase()) ?? false
                  }
                  text={(value) => renderSlackChannel(slack.channels, value)}
                >
                  {(matches) =>
                    matches?.map((channel) => (
                      <SelectItem key={channel.id} value={`${channel.id}/${channel.name}`}>
                        <SlackChannelTitle {...channel} />
                      </SelectItem>
                    ))
                  }
                </Select>
                {selectedSlackChannel && selectedSlackChannel.is_private && (
                  <Callout
                    variant="warning"
                    className={cn("text-sm", variantClasses.warning.textColor)}
                  >
                    To receive alerts in the{" "}
                    <InlineCode variant="extra-small">{selectedSlackChannel.name}</InlineCode>{" "}
                    channel, you need to invite the @Trigger.dev Slack Bot. Go to the channel in
                    Slack and type:{" "}
                    <InlineCode variant="extra-small">/invite @Trigger.dev</InlineCode>.
                  </Callout>
                )}

                <input type="hidden" name="integrationId" value={slack.integrationId} />
              </>
            ) : slack.status === "NOT_CONFIGURED" ? (
              <LinkButton
                variant="tertiary/large"
                to={returnToParam ? `${connectToSlackPath}?${returnToParam}` : connectToSlackPath}
                onClick={onConnect}
                fullWidth
              >
                <span className="flex items-center gap-2 text-text-bright">
                  <SlackIcon className="size-5" /> Connect to Slack
                </span>
              </LinkButton>
            ) : slack.status === "TOKEN_REVOKED" || slack.status === "TOKEN_EXPIRED" ? (
              <div className="flex flex-col gap-4">
                <Callout variant="info">
                  The Slack integration in your workspace has been revoked or has expired. Please
                  re-connect your Slack workspace.
                </Callout>
                <LinkButton
                  variant="tertiary/large"
                  to={{
                    pathname: connectToSlackPath,
                    search: `?reinstall=true${returnToParam ? `&${returnToParam}` : ""}`,
                  }}
                  onClick={onConnect}
                  fullWidth
                >
                  <span className="flex items-center gap-2 text-text-bright">
                    <SlackIcon className="size-5" /> Connect to Slack
                  </span>
                </LinkButton>
              </div>
            ) : slack.status === "FAILED_FETCHING_CHANNELS" ? (
              <div className="flex flex-col gap-4">
                <Callout variant="warning">
                  Failed loading channels from Slack. Please try again later.
                </Callout>
              </div>
            ) : (
              <Callout variant="warning">
                Slack integration is not available. Please contact your organization administrator.
              </Callout>
            )}
            {mode === "edit" && slack.status !== "READY" && (
              <input type="hidden" name={channelValue.name} value={defaultChannelValue ?? ""} />
            )}
            <FormError id={channelValue.errorId}>{channelValue.errors}</FormError>
          </InputGroup>
        ) : (
          <InputGroup fullWidth>
            <Label>URL</Label>
            <Input
              {...getInputProps(channelValue, { type: "text" })}
              placeholder="https://foobar.com/webhooks"
              type="url"
              autoFocus={!inline}
            />
            <FormError id={channelValue.errorId}>{channelValue.errors}</FormError>
            <Hint>We'll issue POST requests to this URL with a JSON payload.</Hint>
          </InputGroup>
        )}

        {extraFields}
        <FormError>{form.errors}</FormError>
        <FormButtons
          confirmButton={
            <Button
              variant="primary/medium"
              disabled={isLoading || submitDisabled}
              name="action"
              value={intent ?? mode}
            >
              {isLoading ? "Saving…" : "Save"}
            </Button>
          }
          cancelButton={
            onClose ? (
              <Button type="button" variant="secondary/medium" onClick={onClose}>
                Cancel
              </Button>
            ) : inline ? undefined : (
              <LinkButton
                to={v3ProjectAlertChannelsPath(organization, project, environment)}
                variant="secondary/medium"
              >
                Cancel
              </LinkButton>
            )
          }
        />
      </Fieldset>
    </FormElement>
  );

  if (inline) return formElement;

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) close();
      }}
    >
      <DialogContent>
        <DialogHeader>{mode === "edit" ? "Edit channel" : "New channel"}</DialogHeader>
        {formElement}
      </DialogContent>
    </Dialog>
  );
}

function SlackChannelTitle({ name, is_private }: { name?: string; is_private?: boolean }) {
  return (
    <div className="flex items-center gap-1.5">
      {is_private ? <LockClosedIcon className="size-4" /> : <HashtagIcon className="size-4" />}
      <span>{name}</span>
    </div>
  );
}
