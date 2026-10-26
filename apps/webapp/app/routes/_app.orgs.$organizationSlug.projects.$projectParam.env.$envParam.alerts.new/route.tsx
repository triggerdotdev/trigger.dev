import { getFormProps, getInputProps, getSelectProps, useForm } from "@conform-to/react";
import { parseWithZod } from "@conform-to/zod/v4";
import { HashtagIcon, LockClosedIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useNavigate, useNavigation } from "@remix-run/react";
import { json, redirect } from "@remix-run/server-runtime";
import { SlackIcon } from "@trigger.dev/companyicons";
import { useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import {
  AlertChannelForm,
  AlertChannelFormSchema,
  formDataToAlertChannel,
} from "~/components/alerts/AlertChannelForm";
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
import { RuntimeEnvironmentType } from "~/database-types";
import { env } from "~/env.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { NewAlertChannelPresenter } from "~/presenters/v3/NewAlertChannelPresenter.server";
import { logger } from "~/services/logger.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import type { RbacAbility } from "@trigger.dev/rbac";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { requireAcrossEnvironments } from "~/v3/services/dashboardResourceAccess.server";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  v3AlertCreatePath,
  v3ProjectAlertChannelsPath,
  v3ProjectAlertsPath,
} from "~/utils/pathBuilder";
import {
  type CreateAlertChannelOptions,
  CreateAlertChannelService,
} from "~/v3/services/alerts/createAlertChannel.server";
import {
  assertSafeWebhookUrl,
  UnsafeWebhookUrlError,
} from "~/v3/services/alerts/safeWebhookUrl.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { pageMeta } from "~/utils/pageTitle";
import { canUseAlertsListForSlug } from "~/v3/canUseAlertsList.server";

type SlackChannel = { id?: string; name?: string; is_private?: boolean };

function renderSlackChannel(channels: SlackChannel[], value: string | string[]) {
  if (typeof value !== "string") return;
  const channel = channels.find((channel) => value === `${channel.id}/${channel.name}`);
  return channel ? <SlackChannelTitle {...channel} /> : undefined;
}

export const meta = pageMeta("New alert");

const legacyAlertTypes: CreateAlertChannelOptions["alertTypes"] = [
  "TASK_RUN",
  "DEPLOYMENT_FAILURE",
  "DEPLOYMENT_SUCCESS",
];

const allEnvironmentTypes: CreateAlertChannelOptions["environmentTypes"] =
  Object.values(RuntimeEnvironmentType);

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

export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "write", resource: { type: "alerts" } },
  },
  async ({ request, params, user }) => {
    const userId = user.id;
    const { organizationSlug, projectParam, envParam } = params;
    const alertsListEnabled = await canUseAlertsListForSlug(userId, organizationSlug);

    const url = new URL(request.url);
    const option = url.searchParams.get("option");

    if (alertsListEnabled && option === null) {
      throw redirect(
        v3AlertCreatePath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam })
      );
    }

    const project = await findProjectBySlug(organizationSlug, projectParam, userId);

    if (!project) {
      throw new Response("Project not found", { status: 404 });
    }

    const presenter = new NewAlertChannelPresenter();

    const results = await presenter.call(project.id);

    const emailAlertsEnabled =
      env.ALERT_FROM_EMAIL !== undefined && env.ALERT_RESEND_API_KEY !== undefined;

    return typedjson({
      ...results,
      option: option === "slack" ? ("SLACK" as const) : undefined,
      emailAlertsEnabled,
      alertsListEnabled,
    });
  }
);

async function legacyAction(
  request: Request,
  userId: string,
  ability: RbacAbility,
  { organizationSlug, projectParam, envParam }: z.infer<typeof EnvironmentParamSchema>
) {
  const formData = await request.formData();

  const submission = parseWithZod(formData, { schema: FormSchema });

  if (submission.status !== "success") {
    return json(submission.reply());
  }

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);

  if (!project) {
    return json(submission.reply({ formErrors: ["Project not found"] }));
  }

  // Validate the webhook URL before storing it, for an inline field error.
  if (submission.value.type === "WEBHOOK") {
    try {
      await assertSafeWebhookUrl(submission.value.channelValue);
    } catch (error) {
      if (error instanceof UnsafeWebhookUrlError) {
        return json(submission.reply({ fieldErrors: { channelValue: [error.message] } }));
      }
      throw error;
    }
  }

  const options = formDataToCreateAlertChannelOptions(submission.value);
  requireAcrossEnvironments(ability, "write", "alerts", options.environmentTypes);

  const service = new CreateAlertChannelService();
  let alertChannel;
  try {
    alertChannel = await service.call(project.externalRef, userId, options);
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return json(submission.reply({ formErrors: [error.message] }));
    }
    throw error;
  }

  if (!alertChannel) {
    return json(submission.reply({ formErrors: ["Failed to create alert channel"] }));
  }

  return redirectWithSuccessMessage(
    v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }, { slug: envParam }),
    request,
    `Created ${alertChannel.name} alert`
  );
}

export const action = dashboardAction(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "write", resource: { type: "alerts" } },
  },
  async ({ request, params, user, ability }) => {
    const userId = user.id;
    const { organizationSlug, projectParam, envParam } = params;

    if (request.method.toUpperCase() !== "POST") {
      throw new Response("Method Not Allowed", { status: 405 });
    }

    if (!(await canUseAlertsListForSlug(userId, organizationSlug))) {
      return legacyAction(request, userId, ability, { organizationSlug, projectParam, envParam });
    }

    const formData = await request.formData();

    const submission = parseWithZod(formData, { schema: AlertChannelFormSchema });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    const project = await findProjectBySlug(organizationSlug, projectParam, userId);

    if (!project) {
      return json(submission.reply({ formErrors: ["Project not found"] }));
    }

    // Validate the webhook URL before storing it, for an inline field error.
    if (submission.value.type === "WEBHOOK") {
      try {
        await assertSafeWebhookUrl(submission.value.channelValue);
      } catch (error) {
        if (error instanceof UnsafeWebhookUrlError) {
          return json(submission.reply({ fieldErrors: { channelValue: [error.message] } }));
        }
        throw error;
      }
    }

    requireAcrossEnvironments(ability, "write", "alerts", allEnvironmentTypes);

    const service = new CreateAlertChannelService();
    let alertChannel;
    try {
      alertChannel = await service.call(project.externalRef, userId, {
        ...formDataToAlertChannel(submission.value),
        alertTypes: legacyAlertTypes,
        environmentTypes: allEnvironmentTypes,
      });
    } catch (error) {
      if (error instanceof Response) throw error;
      if (error instanceof ServiceValidationError) {
        return json(submission.reply({ formErrors: [error.message] }));
      }
      logger.error("Failed to create alert channel", {
        organizationId: project.organizationId,
        projectId: project.id,
        userId,
        error,
      });
      throw error;
    }

    if (!alertChannel) {
      return json(submission.reply({ formErrors: ["Failed to create alert channel"] }));
    }

    return redirectWithSuccessMessage(
      v3ProjectAlertChannelsPath(
        { slug: organizationSlug },
        { slug: projectParam },
        { slug: envParam }
      ),
      request,
      `Created ${alertChannel.name} alert`
    );
  }
);

export default function Page() {
  const { slack, option, emailAlertsEnabled, alertsListEnabled } =
    useTypedLoaderData<typeof loader>();

  if (!alertsListEnabled) {
    return (
      <LegacyNewAlertDialog slack={slack} option={option} emailAlertsEnabled={emailAlertsEnabled} />
    );
  }

  return (
    <AlertChannelForm
      mode="create"
      slack={slack}
      emailAlertsEnabled={emailAlertsEnabled}
      defaultType={option ?? "EMAIL"}
    />
  );
}

function LegacyNewAlertDialog({
  slack,
  option,
  emailAlertsEnabled,
}: {
  slack: React.ComponentProps<typeof AlertChannelForm>["slack"];
  option?: "SLACK";
  emailAlertsEnabled: boolean;
}) {
  const lastSubmission = useActionData();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [currentAlertChannel, setCurrentAlertChannel] = useState<string | null>(option ?? "EMAIL");
  const formRef = useRef<HTMLFormElement>(null);

  const [selectedSlackChannelValue, setSelectedSlackChannelValue] = useState<string | undefined>();

  const selectedSlackChannel = slack.channels?.find(
    (s) => selectedSlackChannelValue === `${s.id}/${s.name}`
  );

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "create";

  const [
    form,
    { channelValue, alertTypes, environmentTypes, type, integrationId: _integrationId },
  ] = useForm({
    id: "create-alert",
    // TODO: type this
    lastResult: lastSubmission as any,
    onValidate({ formData }) {
      return parseWithZod(formData, { schema: FormSchema });
    },
    shouldRevalidate: "onSubmit",
  });

  useEffect(() => {
    if (navigation.state !== "idle") return;
    if (lastSubmission !== undefined) return;

    formRef.current?.reset();
  }, [navigation.state, lastSubmission]);

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          navigate(v3ProjectAlertsPath(organization, project, environment));
        }
      }}
    >
      <DialogContent>
        <DialogHeader>New alert</DialogHeader>
        <Form ref={formRef} method="post" {...getFormProps(form)}>
          <Fieldset className="mt-2">
            <InputGroup fullWidth>
              <SegmentedControl
                {...getInputProps(type, { type: "text" })}
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
                    {...getInputProps(channelValue, { type: "text" })}
                    placeholder="email@youremail.com"
                    type="email"
                    autoFocus
                  />
                  <FormError id={channelValue.errorId}>{channelValue.errors}</FormError>
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
                      {...getSelectProps(channelValue)}
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

                    <FormError id={channelValue.errorId}>{channelValue.errors}</FormError>
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
                  {...getInputProps(channelValue, { type: "text" })}
                  placeholder="https://foobar.com/webhooks"
                  type="url"
                  autoFocus
                />
                <FormError id={channelValue.errorId}>{channelValue.errors}</FormError>
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

              <FormError id={alertTypes.errorId}>{alertTypes.errors}</FormError>
            </InputGroup>
            <InputGroup>
              <Label>Environment</Label>
              <input type="hidden" name={environmentTypes.name} value={environment.type} />
              <EnvironmentCombo environment={{ type: environment.type }} />
              <FormError id={environmentTypes.errorId}>{environmentTypes.errors}</FormError>
            </InputGroup>
            <FormError>{form.errors}</FormError>
            <FormButtons
              confirmButton={
                <Button variant="primary/medium" disabled={isLoading} name="action" value="create">
                  {isLoading ? "Saving…" : "Save"}
                </Button>
              }
              cancelButton={
                <LinkButton
                  to={v3ProjectAlertsPath(organization, project, environment)}
                  variant="secondary/medium"
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
