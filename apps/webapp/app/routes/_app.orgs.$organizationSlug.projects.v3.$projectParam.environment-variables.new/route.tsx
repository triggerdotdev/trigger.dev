import { Submission, conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData, useLocation, useNavigate, useNavigation } from "@remix-run/react";
import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { Fragment, useEffect, useRef, useState } from "react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { EnvironmentVariablesPresenter } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  ProjectParamSchema,
  v3EnvironmentVariablesPath,
  v3NewEnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { CreateEnvironmentVariable } from "~/v3/environmentVariables/repository";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new EnvironmentVariablesPresenter();
    const { environmentVariables, environments } = await presenter.call({
      userId,
      projectSlug: projectParam,
    });

    return typedjson({
      environmentVariables,
      environments,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

const schema = z.object({
  action: z.enum(["create", "create-more"]),
  ...CreateEnvironmentVariable.shape,
});

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

  const project = await prisma.project.findUnique({
    where: {
      slug: params.projectParam,
    },
    select: {
      id: true,
    },
  });
  if (!project) {
    submission.error.key = "Project not found";
    return json(submission);
  }

  const repository = new EnvironmentVariablesRepository(prisma);
  const result = await repository.create(project.id, userId, submission.value);

  if (!result.success) {
    submission.error.key = result.error;
    return json(submission);
  }

  switch (submission.value.action) {
    case "create":
      return redirect(
        v3EnvironmentVariablesPath({ slug: organizationSlug }, { slug: projectParam })
      );
    case "create-more":
      return redirectWithSuccessMessage(
        v3NewEnvironmentVariablesPath({ slug: organizationSlug }, { slug: projectParam }),
        request,
        `Created ${submission.value.key} environment variable`
      );
  }
};

export default function Page() {
  const [isOpen, setIsOpen] = useState(false);
  const { environmentVariables, environments } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const organization = useOrganization();
  const project = useProject();
  const keyFieldRef = useRef<HTMLInputElement>(null);

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "create";

  const [form, { key }] = useForm({
    id: "create-environment-variable",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
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
    keyFieldRef.current?.focus();
  }, [navigation.state, lastSubmission]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(o) => {
        if (!o) {
          navigate(v3EnvironmentVariablesPath(organization, project));
        }
      }}
    >
      <DialogContent>
        <DialogHeader>New environment variable</DialogHeader>
        <Form method="post" {...form.props}>
          <Fieldset className="mt-2">
            <InputGroup fullWidth>
              <Label>Key</Label>
              <Input
                {...conform.input(key)}
                placeholder="e.g. CLIENT_KEY"
                autoFocus
                ref={keyFieldRef}
              />
            </InputGroup>
            <InputGroup fullWidth>
              <Label>Values</Label>
              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-2">
                {environments.map((environment, index) => {
                  return (
                    <Fragment key={environment.id}>
                      <input
                        type="hidden"
                        name={`values[${index}].environmentId`}
                        value={environment.id}
                      />
                      <label
                        className="flex items-center justify-end"
                        htmlFor={`values[${index}].value`}
                      >
                        <EnvironmentLabel environment={environment} className="h-5 px-2" />
                      </label>
                      <Input name={`values[${index}].value`} placeholder="Not set" />
                    </Fragment>
                  );
                })}
              </div>
            </InputGroup>

            <Callout variant="info" className="inline-flex">
              Dev environment variables specified here will be overriden by ones in your{" "}
              <InlineCode variant="extra-small">.env</InlineCode> file when running locally.
            </Callout>

            <FormError id={key.errorId}>{key.error}</FormError>
            <FormError>{form.error}</FormError>
            <FormButtons
              confirmButton={
                <div className="flex flex-row-reverse items-center gap-2">
                  <Button
                    type="submit"
                    variant="primary/small"
                    disabled={isLoading}
                    name="action"
                    value="create-more"
                  >
                    {isLoading ? "Saving" : "Save and add another"}
                  </Button>
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
                  to={v3EnvironmentVariablesPath(organization, project)}
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
