import {
  FieldConfig,
  Submission,
  conform,
  list,
  requestIntent,
  useFieldList,
  useFieldset,
  useForm,
} from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { PlusIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useLocation, useNavigate, useNavigation } from "@remix-run/react";
import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { Fragment, RefObject, useEffect, useRef, useState } from "react";
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
import { logger } from "~/services/logger.server";
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
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

const Variable = z.object({
  key: EnvironmentVariableKey,
  value: z.string().nonempty("Value is required"),
});

type Variable = z.infer<typeof Variable>;

const schema = z.object({
  environmentIds: z.preprocess((i) => {
    if (typeof i === "string") return [i];

    if (Array.isArray(i)) {
      const ids = i.filter((v) => typeof v === "string" && v !== "");
      if (ids.length === 0) {
        return;
      }
      return ids;
    }

    return;
  }, z.array(z.string(), { required_error: "At least one environment is required" })),
  variables: z.preprocess((i) => {
    if (!Array.isArray(i)) {
      return [];
    }

    //remove empty variables (key and value are empty)
    const filtered = i.filter((v: any) => {
      if (!v) return false;
      if (!v.key && !v.value) return false;
      return true;
    });

    if (filtered.length === 0) {
      return [
        {
          key: "",
          value: "",
        },
      ];
    }

    return filtered;
  }, Variable.array().nonempty("At least one variable is required")),
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
    if (result.variableErrors) {
      for (const { key, error } of result.variableErrors) {
        const index = submission.value.variables.findIndex((v) => v.key === key);

        if (index !== -1) {
          submission.error[`variables[${index}].key`] = error;
        }
      }
    } else {
      submission.error.variables = result.error;
    }

    return json(submission);
  }

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

  const [form, { environmentIds, variables }] = useForm({
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

  const variableFields = useFieldList(form.ref, variables);

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
            <InputGroup fullWidth>
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
              <FormError id={environmentIds.errorId}>{environmentIds.error}</FormError>
              <Hint>
                Dev environment variables specified here will be overridden by ones in your .env
                file when running locally.
              </Hint>
            </InputGroup>
            <Hint>Tip: Paste your .env into this form to populate it:</Hint>
            <InputGroup fullWidth>
              <FieldLayout>
                <Label>Keys</Label>
                <div className="flex justify-between gap-1">
                  <Label>Values</Label>
                  <Switch
                    variant="small"
                    label="Reveal"
                    checked={revealAll}
                    onCheckedChange={(e) => setRevealAll(e.valueOf())}
                  />
                </div>
              </FieldLayout>
              {variableFields.map((variable, index) => {
                return (
                  <Fragment key={variable.key}>
                    <VariableFieldset
                      config={variable}
                      index={index}
                      count={variableFields.length}
                      formRef={form.ref}
                      variables={variables}
                      revealAll={revealAll}
                    />
                  </Fragment>
                );
              })}
              <FormError id={variables.errorId}>{variables.error}</FormError>
              <Button
                variant="tertiary/medium"
                type="button"
                onClick={() =>
                  requestIntent(form.ref.current ?? undefined, list.append(variables.name))
                }
                LeadingIcon={PlusIcon}
              >
                Add another
              </Button>
            </InputGroup>

            <FormError>{form.error}</FormError>
            <FormButtons
              confirmButton={
                <Button variant="primary/small" disabled={isLoading}>
                  {isLoading ? "Saving" : "Save"}
                </Button>
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

function VariableFieldset({
  config,
  index,
  count,
  formRef,
  variables,
  revealAll,
}: {
  config: FieldConfig<Variable>;
  index: number;
  count: number;
  formRef: RefObject<HTMLFormElement>;
  variables: FieldConfig<any>;
  revealAll: boolean;
}) {
  const ref = useRef<HTMLFieldSetElement>(null);
  // useFieldset / useFieldList accepts both form or fieldset ref
  const { key, value } = useFieldset(ref, config);

  return (
    <fieldset ref={ref}>
      <FieldLayout>
        <Input {...conform.input(key)} placeholder="e.g. CLIENT_KEY" />
        <Input
          {...conform.input(value, { type: revealAll ? "text" : "password" })}
          placeholder="Not set"
        />
        {count > 1 && (
          <Button
            variant="minimal/medium"
            type="button"
            onClick={() =>
              requestIntent(formRef.current ?? undefined, list.remove(variables.name, { index }))
            }
            LeadingIcon={XMarkIcon}
          />
        )}
      </FieldLayout>
      <div className="space-y-2">
        <FormError id={key.errorId}>{key.error}</FormError>
        <FormError id={value.errorId}>{value.error}</FormError>
      </div>
    </fieldset>
  );
}

function FieldLayout({ children }: { children: React.ReactNode }) {
  return <div className="grid w-full grid-cols-[1fr_1fr_2rem] gap-2">{children}</div>;
}
