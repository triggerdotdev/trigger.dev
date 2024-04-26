import { Submission, conform, useFieldList, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, useActionData, useLocation, useNavigate, useNavigation } from "@remix-run/react";
import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { Fragment, useEffect, useRef, useState } from "react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import {
  EnvironmentLabel,
  environmentTextClassName,
  environmentTitle,
} from "~/components/environments/EnvironmentLabel";
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
import { Switch } from "~/components/primitives/Switch";
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { EnvironmentVariablesPresenter } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  ProjectParamSchema,
  v3EnvironmentVariablesPath,
  v3NewEnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  CreateEnvironmentVariables,
  EnvironmentVariableKey,
} from "~/v3/environmentVariables/repository";

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
  environmentIds: z.array(z.string()),

  keys: z.preprocess((i) => {
    if (typeof i === "string") return [i];

    if (Array.isArray(i)) {
      const keys = i.filter((v) => typeof v === "string" && v !== "");
      if (keys.length === 0) {
        return [""];
      }
      return keys;
    }

    return [""];
  }, EnvironmentVariableKey.array().nonempty("At least one key is required")),
  values: z.preprocess((i) => {
    if (typeof i === "string") return [i];

    if (Array.isArray(i)) {
      const values = i.filter((v) => typeof v === "string" && v !== "");
      if (values.length === 0) {
        return [""];
      }
      return values;
    }

    return [""];
  }, z.string().array().nonempty("At least one value is required")),
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
  //todo implement
  // const result = await repository.create(project.id, userId, submission.value);

  // if (!result.success) {
  //   submission.error.key = result.error;
  //   return json(submission);
  // }

  return redirect(v3EnvironmentVariablesPath({ slug: organizationSlug }, { slug: projectParam }));
};

export default function Page() {
  const [isOpen, setIsOpen] = useState(false);
  const { environmentVariables, environments } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const organization = useOrganization();
  const project = useProject();

  const isLoading = navigation.state !== "idle" && navigation.formMethod === "post";

  const [form, { environmentIds, keys, values }] = useForm({
    id: "create-environment-variables",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onSubmit",
  });

  const [revealAll, setRevealAll] = useState(false);

  useEffect(() => {
    setIsOpen(true);
  }, []);

  const keyFieldValues = useRef<string[]>([""]);
  const keyFields = useFieldList(form.ref, keys);
  const valueFieldValues = useRef<string[]>([""]);
  const valueFields = useFieldList(form.ref, values);

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
        <DialogHeader>New environment variables</DialogHeader>
        <Form method="post" {...form.props}>
          <Fieldset className="mt-2">
            <InputGroup>
              <Label>Environments</Label>
              <div className="flex flex-wrap items-center gap-2">
                {environments.map((environment) => (
                  <Checkbox
                    key={environment.id}
                    id={environment.id}
                    value={environment.id}
                    name="environmentIds"
                    type="radio"
                    label={
                      <span
                        className={cn("text-xs uppercase", environmentTextClassName(environment))}
                      >
                        {environmentTitle(environment)}
                      </span>
                    }
                    variant="button"
                  />
                ))}
              </div>
              <Hint>
                Dev environment variables specified here will be overridden by ones in your .env
                file when running locally.
              </Hint>
              <FormError id={environmentIds.errorId}>{environmentIds.error}</FormError>
            </InputGroup>

            <InputGroup fullWidth>
              <Label>Keys</Label>
              <Input {...conform.input(key)} placeholder="e.g. CLIENT_KEY" autoFocus />
            </InputGroup>
            <InputGroup fullWidth>
              <div className="flex items-center justify-between">
                <Label>Values</Label>
                <Switch
                  variant="small"
                  label="Reveal values"
                  checked={revealAll}
                  onCheckedChange={(e) => setRevealAll(e.valueOf())}
                />
              </div>
            </InputGroup>

            <Callout variant="info" className="inline-flex">
              Dev environment variables specified here will be overridden by ones in your{" "}
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
