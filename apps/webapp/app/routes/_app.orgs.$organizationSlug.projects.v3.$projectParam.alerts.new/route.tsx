import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { HashtagIcon, LockClosedIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useNavigate, useNavigation } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/router";
import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { SlackIcon } from "@trigger.dev/companyicons";
import { useEffect, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Checkbox } from "~/components/primitives/Checkbox";
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
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
import { NewAlertChannelPresenter } from "~/presenters/v3/NewAlertChannelPresenter.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema, v3ProjectAlertsPath } from "~/utils/pathBuilder";
import {
  CreateAlertChannelOptions,
  CreateAlertChannelService,
} from "~/v3/services/alerts/createAlertChannel.server";

const FormSchema = z
  .object({
    alertTypes: z
      .array(z.enum(["TASK_RUN_ATTEMPT", "DEPLOYMENT_FAILURE", "DEPLOYMENT_SUCCESS"]))
      .min(1)
      .or(z.enum(["TASK_RUN_ATTEMPT", "DEPLOYMENT_FAILURE", "DEPLOYMENT_SUCCESS"])),
    environmentTypes: z
      .array(z.enum(["STAGING", "PRODUCTION"]))
      .min(1)
      .or(z.enum(["STAGING", "PRODUCTION"])),
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

  return typedjson({
    ...results,
    option: option === "slack" ? ("SLACK" as const) : undefined,
  });
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

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
    submission.error.key = "Project not found";
    return json(submission);
  }

  const service = new CreateAlertChannelService();
  const alertChannel = await service.call(
    project.externalRef,
    userId,
    formDataToCreateAlertChannelOptions(submission.value)
  );

  if (!alertChannel) {
    submission.error.key = "Failed to create alert channel";
    return json(submission);
  }

  return redirectWithSuccessMessage(
    v3ProjectAlertsPath({ slug: organizationSlug }, { slug: projectParam }),
    request,
    `Created ${alertChannel.name} alert`
  );
};

export default function Page() {
  const [isOpen, setIsOpen] = useState(false);
  const { slack, option } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const organization = useOrganization();
  const project = useProject();
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
          navigate(v3ProjectAlertsPath(organization, project));
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
                      <Callout variant="warning">
                        Heads up! To receive alerts in the{" "}
                        <InlineCode variant="extra-small">{selectedSlackChannel.name}</InlineCode>{" "}
                        channel, you will need to invite the @Trigger.dev Slack Bot. You can do this
                        by visiting the channel in your Slack workspace issue the following command:{" "}
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
                <Checkbox
                  name={alertTypes.name}
                  id="TASK_RUN_ATTEMPT"
                  value="TASK_RUN_ATTEMPT"
                  variant="simple/small"
                  label="Task run attempts fail"
                  defaultChecked
                  className="pr-0"
                />
                <InfoIconTooltip content="You'll receive an alert every time an attempt fails on a run." />
              </div>

              <Checkbox
                name={alertTypes.name}
                id="DEPLOYMENT_FAILURE"
                value="DEPLOYMENT_FAILURE"
                variant="simple/small"
                label="Deployments fail"
                defaultChecked
              />

              <Checkbox
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
              <Label>Environments</Label>
              <Checkbox
                name={environmentTypes.name}
                id="PRODUCTION"
                value="PRODUCTION"
                variant="simple/small"
                label="PROD"
                defaultChecked
              />
              <Checkbox
                name={environmentTypes.name}
                id="STAGING"
                value="STAGING"
                variant="simple/small"
                label="STAGING"
                defaultChecked
              />

              <FormError id={environmentTypes.errorId}>{environmentTypes.error}</FormError>
            </InputGroup>
            <FormError>{form.error}</FormError>
            <div className="border-t border-grid-bright pt-3">
              <FormButtons
                confirmButton={
                  <Button
                    variant="primary/medium"
                    disabled={isLoading}
                    name="action"
                    value="create"
                  >
                    {isLoading ? "Saving…" : "Save"}
                  </Button>
                }
                cancelButton={
                  <LinkButton
                    to={v3ProjectAlertsPath(organization, project)}
                    variant="tertiary/medium"
                  >
                    Cancel
                  </LinkButton>
                }
              />
            </div>
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
