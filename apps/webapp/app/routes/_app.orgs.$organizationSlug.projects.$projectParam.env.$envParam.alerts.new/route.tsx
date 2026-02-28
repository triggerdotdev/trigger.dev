import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { HashtagIcon, LockClosedIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useNavigate, useNavigation } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/router";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { SlackIcon } from "@trigger.dev/companyicons";
import { useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout, variantClasses } from "~/components/primitives/Callout";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
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
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { env } from "~/env.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { NewAlertChannelPresenter } from "~/presenters/v3/NewAlertChannelPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  ProjectParamSchema,
  v3ProjectAlertsPath,
} from "~/utils/pathBuilder";
import {
  type CreateAlertChannelOptions,
  CreateAlertChannelService,
} from "~/v3/services/alerts/createAlertChannel.server";

const FormSchema = z
  .object({
    alertTypes: z
      .array(z.enum(["TASK_RUN", "DEPLOYMENT_FAILURE", "DEPLOYMENT_SUCCESS"]))
      .min(1)
      .or(z.enum(["TASK_RUN", "DEPLOYMENT_FAILURE", "DEPLOYMENT_SUCCESS"])),
    environmentTypes: z
      .array(z.enum(["STAGING", "PRODUCTION", "PREVIEW"]))
      .min(1)
      .or(z.enum(["STAGING", "PRODUCTION", "PREVIEW"])),
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

function formDataToCreateAlertChannelOptions(
  formData: z.infer<typeof FormSchema>
): CreateAlertChannelOptions {
  switch (formData.type) {
    case "WEBHOOK": {
      return {
        name: `Webhook to ${new URL(formData.channelValue).hostname}`,
        alertTypes: Array.isArray(formData.alertTypes)
          ? formData.alertTypes
          : [formData.alertTypes],
        environmentTypes: Array.isArray(formData.environmentTypes)
          ? formData.environmentTypes
          : [formData.environmentTypes],
        channel: {
          type: "WEBHOOK",
          url: formData.channelValue,
        },
      };
    }
    case "EMAIL": {
      return {
        name: `Email to ${formData.channelValue}`,
        alertTypes: Array.isArray(formData.alertTypes)
          ? formData.alertTypes
          : [formData.alertTypes],
        environmentTypes: Array.isArray(formData.environmentTypes)
          ? formData.environmentTypes
          : [formData.environmentTypes],
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
        alertTypes: Array.isArray(formData.alertTypes)
          ? formData.alertTypes
          : [formData.alertTypes],
        environmentTypes: Array.isArray(formData.environmentTypes)
          ? formData.environmentTypes
          : [formData.environmentTypes],
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

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const presenter = new NewAlertChannelPresenter();

  const results = await presenter.call(project.id);

  const url = new URL(request.url);
  const option = url.searchParams.get("option");

  const emailAlertsEnabled =
    env.ALERT_FROM_EMAIL !== undefined && (env.ALERT_RESEND_API_KEY !== undefined || env.ALERT_SMTP_HOST !== undefined);

  return typedjson({
    ...results,
    option: option === "slack" ? ("SLACK" as const) : undefined,
    emailAlertsEnabled,
  });
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const formData = await request.formData();

  const submission = parse(formData, { schema: FormSchema });

  if (!submission.value) {
    return json(submission);
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    submission.error.key = ["Project not found"];
    return json(submission);
  }

  const service = new CreateAlertChannelService();
  const alertChannel = await service.call(
    project.externalRef,
    userId,
    formDataToCreateAlertChannelOptions(submission.value)
  );

  if (!alertChannel) {
    submission.error.key = ["Failed to create alert channel"];
    return json(submission);
  }

  return redirectWithSuccessMessage(
    v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
    request,
    `Created ${alertChannel.name} alert`
  );
};

export default function Page() {
  const [isOpen, setIsOpen] = useState(false);
  const { slack, option, emailAlertsEnabled } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [currentAlertChannel, setCurrentAlertChannel] = useState<string | null>(option ?? "EMAIL");

  const [selectedSlackChannelValue, setSelectedSlackChannelValue] = useState<string | undefined>();

  const selectedSlackChannel = slack.channels?.find(
    (s) => selectedSlackChannelValue === `${s.id}/${s.name}`
  );

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "create";

  const [form, { channelValue: channelValue, alertTypes, environmentTypes, type, integrationId }] =
    useForm({
      id: "create-alert",
      // TODO: type this
      lastSubmission: lastSubmission as any,
      onValidate({ formData }) {
        return parse(formData, { schema: FormSchema });
      },
      shouldRevalidate: "onSubmit",
    });

  useEffect(() => {
    setIsOpen(true);
  }, []);

  useEffect(() => {
    if (navigation.state !== "idle") return;
    if (lastSubmission !== undefined) return;

    form.ref.current?.reset();
  }, [navigation.state, lastSubmission]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(o) => {
        if (!o) {
          navigate(v3ProjectAlertsPath(organization, project, environment));
        }
      }}
    >
      <DialogContent>
        <DialogHeader>New alert</DialogHeader>
        <Form method="post" {...form.props}>
          <Fieldset className="mt-2">
            <InputGroup fullWidth>
              <SegmentedControl
                {...conform.input(type)}
                options={[
                  { label: "Email", value: "EMAIL" },
                  { label: "Slack", value: "SLACK" },
                  { label: "Webhook", value: "WEBHOOK" },
                ]}
                onChange={(value) => {
                  setCurrentAlertChannel(value);
                }}
                fullWidth
                defaultValue={currentAlertChannel ?? undefined}
              />
            </InputGroup>

            {currentAlertChannel === "EMAIL" ? (
              emailAlertsEnabled ? (
                <InputGroup fullWidth>
                  <Label>Email</Label>
                  <Input
                    {...conform.input(channelValue)}
                    placeholder="email@youremail.com"
                    type="email"
                    autoFocus
                  />
                  <FormError id={channelValue.errorId}>{channelValue.error}</FormError>
                </InputGroup>
              ) : (
                <Callout variant="warning">
                  Email integration is not available. Please contact your organization
                  administrator.
                </Callout>
              )
            ) : currentAlertChannel === "SLACK" ? (
              <InputGroup fullWidth>
                {slack.status === "READY" ? (
                  <>
                    <Select
                      {...conform.select(channelValue)}
                      placeholder="Select a Slack channel"
                      heading="Filter channels…"
                      defaultValue={undefined}
                      dropdownIcon
                      variant="tertiary/medium"
                      items={slack.channels}
                      setValue={(value) => {
                        typeof value === "string" && setSelectedSlackChannelValue(value);
                      }}
                      filter={(channel, search) =>
                        channel.name?.toLowerCase().includes(search.toLowerCase()) ?? false
                      }
                      text={(value) => {
                        const channel = slack.channels.find((s) => value === `${s.id}/${s.name}`);
                        if (!channel) return;
                        return <SlackChannelTitle {...channel} />;
                      }}
                    >
                      {(matches) => (
                        <>
                          {matches?.map((channel) => (
                            <SelectItem key={channel.id} value={`${channel.id}/${channel.name}`}>
                              <SlackChannelTitle {...channel} />
                            </SelectItem>
                          ))}
                        </>
                      )}
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

                    <FormError id={channelValue.errorId}>{channelValue.error}</FormError>
                    <input type="hidden" name="integrationId" value={slack.integrationId} />
                  </>
                ) : slack.status === "NOT_CONFIGURED" ? (
                  <LinkButton variant="tertiary/large" to="connect-to-slack" fullWidth>
                    <span className="flex items-center gap-2 text-text-bright">
                      <SlackIcon className="size-5" /> Connect to Slack
                    </span>
                  </LinkButton>
                ) : slack.status === "TOKEN_REVOKED" || slack.status === "TOKEN_EXPIRED" ? (
                  <div className="flex flex-col gap-4">
                    <Callout variant="info">
                      The Slack integration in your workspace has been revoked or has expired.
                      Please re-connect your Slack workspace.
                    </Callout>
                    <LinkButton
                      variant="tertiary/large"
                      to={{
                        pathname: "connect-to-slack",
                        search: "?reinstall=true",
                      }}
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
                    Slack integration is not available. Please contact your organization
                    administrator.
                  </Callout>
                )}
              </InputGroup>
            ) : (
              <InputGroup fullWidth>
                <Label>URL</Label>
                <Input
                  {...conform.input(channelValue)}
                  placeholder="https://foobar.com/webhooks"
                  type="url"
                  autoFocus
                />
                <FormError id={channelValue.errorId}>{channelValue.error}</FormError>
                <Hint>We'll issue POST requests to this URL with a JSON payload.</Hint>
              </InputGroup>
            )}

            <InputGroup>
              <Label>Alert me when</Label>

              <div className="flex items-center gap-1">
                <CheckboxWithLabel
                  name={alertTypes.name}
                  id="TASK_RUN"
                  value="TASK_RUN"
                  variant="simple/small"
                  label="Task runs fail"
                  defaultChecked
                  className="pr-0"
                />
                <InfoIconTooltip content="You'll receive an alert when a run completely fails." />
              </div>

              <CheckboxWithLabel
                name={alertTypes.name}
                id="DEPLOYMENT_FAILURE"
                value="DEPLOYMENT_FAILURE"
                variant="simple/small"
                label="Deployments fail"
                defaultChecked
              />

              <CheckboxWithLabel
                name={alertTypes.name}
                id="DEPLOYMENT_SUCCESS"
                value="DEPLOYMENT_SUCCESS"
                variant="simple/small"
                label="Deployments succeed"
                defaultChecked
              />

              <FormError id={alertTypes.errorId}>{alertTypes.error}</FormError>
            </InputGroup>
            <InputGroup>
              <Label>Environment</Label>
              <input type="hidden" name={environmentTypes.name} value={environment.type} />
              <EnvironmentCombo environment={{ type: environment.type }} />
              <FormError id={environmentTypes.errorId}>{environmentTypes.error}</FormError>
            </InputGroup>
            <FormError>{form.error}</FormError>
            <FormButtons
              confirmButton={
                <Button variant="primary/medium" disabled={isLoading} name="action" value="create">
                  {isLoading ? "Saving…" : "Save"}
                </Button>
              }
              cancelButton={
                <LinkButton
                  to={v3ProjectAlertsPath(organization, project, environment)}
                  variant="tertiary/medium"
                >
                  Cancel
                </LinkButton>
              }
            />
          </Fieldset>
        </Form>
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
