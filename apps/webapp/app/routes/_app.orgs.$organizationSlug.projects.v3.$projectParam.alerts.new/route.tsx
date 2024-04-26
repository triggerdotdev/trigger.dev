import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData, useNavigate, useNavigation } from "@remix-run/react";
import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { useEffect, useState } from "react";
import { z } from "zod";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Checkbox } from "~/components/primitives/Checkbox";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { findProjectBySlug } from "~/models/project.server";
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
    type: z.enum(["WEBHOOK", "EMAIL"]).default("EMAIL"),
    urlOrEmail: z.string().nonempty(),
  })
  .refine(
    (value) =>
      value.type === "EMAIL" ? z.string().email().safeParse(value.urlOrEmail).success : true,
    {
      message: "Must be a valid email address",
      path: ["urlOrEmail"],
    }
  )
  .refine(
    (value) =>
      value.type === "WEBHOOK" ? z.string().url().safeParse(value.urlOrEmail).success : true,
    {
      message: "Must be a valid URL",
      path: ["urlOrEmail"],
    }
  );

function formDataToCreateAlertChannelOptions(
  formData: z.infer<typeof FormSchema>
): CreateAlertChannelOptions {
  const name =
    formData.type === "WEBHOOK"
      ? `Webhook to ${new URL(formData.urlOrEmail).hostname}`
      : `Email to ${formData.urlOrEmail}`;

  if (formData.type === "WEBHOOK") {
    return {
      name,
      alertTypes: Array.isArray(formData.alertTypes) ? formData.alertTypes : [formData.alertTypes],
      channel: {
        type: "WEBHOOK",
        url: formData.urlOrEmail,
      },
    };
  } else {
    return {
      name,
      alertTypes: Array.isArray(formData.alertTypes) ? formData.alertTypes : [formData.alertTypes],
      channel: {
        type: "EMAIL",
        email: formData.urlOrEmail,
      },
    };
  }
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
  const lastSubmission = useActionData();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const organization = useOrganization();
  const project = useProject();
  const [currentAlertChannel, setCurrentAlertChannel] = useState<string | null>("EMAIL");

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "create";

  const [form, { urlOrEmail, alertTypes, type }] = useForm({
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
                  { label: "Webhook", value: "WEBHOOK" },
                ]}
                onChange={(value) => {
                  setCurrentAlertChannel(value);
                }}
              />
            </InputGroup>

            {currentAlertChannel === "EMAIL" ? (
              <InputGroup fullWidth>
                <Label>Email</Label>
                <Input
                  {...conform.input(urlOrEmail)}
                  placeholder="email@youremail.com"
                  type="email"
                  autoFocus
                />
                <FormError id={urlOrEmail.errorId}>{urlOrEmail.error}</FormError>
              </InputGroup>
            ) : (
              <InputGroup fullWidth>
                <Label>URL</Label>
                <Input
                  {...conform.input(urlOrEmail)}
                  placeholder="https://foobar.com/webhooks"
                  type="url"
                  autoFocus
                />
                <FormError id={urlOrEmail.errorId}>{urlOrEmail.error}</FormError>
                <Callout variant="info" className="inline-flex">
                  We'll issue POST requests to this URL with a JSON payload.
                </Callout>
              </InputGroup>
            )}

            <InputGroup fullWidth>
              <Label>Events</Label>

              <Checkbox
                name={alertTypes.name}
                id="TASK_RUN_ATTEMPT"
                value="TASK_RUN_ATTEMPT"
                variant="simple"
                label="Task run failure"
                defaultChecked
              />

              <Checkbox
                name={alertTypes.name}
                id="DEPLOYMENT_FAILURE"
                value="DEPLOYMENT_FAILURE"
                variant="simple"
                label="Deployment failure"
                defaultChecked
              />

              <Checkbox
                name={alertTypes.name}
                id="DEPLOYMENT_SUCCESS"
                value="DEPLOYMENT_SUCCESS"
                variant="simple"
                label="Deployment success"
                defaultChecked
              />

              <FormError id={alertTypes.errorId}>{alertTypes.error}</FormError>
            </InputGroup>

            <FormError>{form.error}</FormError>

            <FormButtons
              confirmButton={
                <div className="flex flex-row-reverse items-center gap-2">
                  <Button
                    variant="secondary/small"
                    disabled={isLoading}
                    name="action"
                    value="create"
                  >
                    {isLoading ? "Saving" : "Save"}
                  </Button>
                </div>
              }
              cancelButton={
                <LinkButton
                  to={v3ProjectAlertsPath(organization, project)}
                  variant="tertiary/small"
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
