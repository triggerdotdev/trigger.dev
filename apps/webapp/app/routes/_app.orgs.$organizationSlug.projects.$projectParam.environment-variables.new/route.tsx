import {
  FieldConfig,
  list,
  requestIntent,
  useFieldList,
  useFieldset,
  useForm,
} from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { LockClosedIcon, LockOpenIcon, PlusIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form, useActionData, useNavigate, useNavigation } from "@remix-run/react";
import { ActionFunctionArgs, LoaderFunctionArgs, json } from "@remix-run/server-runtime";
import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import {
  environmentTextClassName,
  environmentTitle,
} from "~/components/environments/EnvironmentLabel";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CheckboxWithLabel } from "~/components/primitives/Checkbox";
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
import { useList } from "~/hooks/useList";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { EnvironmentVariablesPresenter } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { ProjectParamSchema, v3BillingPath, v3EnvironmentVariablesPath } from "~/utils/pathBuilder";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { EnvironmentVariableKey } from "~/v3/environmentVariables/repository";
import dotenv from "dotenv";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new EnvironmentVariablesPresenter();
    const { environments, hasStaging } = await presenter.call({
      userId,
      projectSlug: projectParam,
    });

    return typedjson({
      environments,
      hasStaging,
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
  override: z.preprocess((i) => {
    if (i === "true") return true;
    if (i === "false") return false;
    return;
  }, z.boolean()),
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

    return i;
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
      organization: {
        members: {
          some: {
            userId,
          },
        },
      },
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
  const result = await repository.create(project.id, submission.value);

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
  const { environments, hasStaging } = useTypedLoaderData<typeof loader>();
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

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(o) => {
        if (!o) {
          navigate(v3EnvironmentVariablesPath(organization, project));
        }
      }}
    >
      <DialogContent className="md:max-w-2xl lg:max-w-3xl">
        <DialogHeader>New environment variables</DialogHeader>
        <Form
          method="post"
          {...form.props}
          className="max-h-[70vh] overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600"
        >
          <Fieldset className="mt-2">
            <InputGroup fullWidth>
              <Label>Environments</Label>
              <div className="flex items-center gap-2">
                {environments.map((environment) => (
                  <CheckboxWithLabel
                    key={environment.id}
                    id={environment.id}
                    value={environment.id}
                    name="environmentIds"
                    type="radio"
                    label={
                      <span
                        className={cn(
                          "text-xs uppercase tracking-wide",
                          environmentTextClassName(environment)
                        )}
                      >
                        {environmentTitle(environment)}
                      </span>
                    }
                    variant="button"
                  />
                ))}
                {!hasStaging && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger>
                        <TextLink
                          to={v3BillingPath(organization)}
                          className="flex w-fit cursor-pointer items-center gap-2 rounded border border-dashed border-charcoal-600 py-3 pl-3 pr-4 transition hover:border-charcoal-500 hover:bg-charcoal-850"
                        >
                          <LockClosedIcon className="size-4 text-charcoal-500" />
                          <Paragraph className="mt-0.5 text-xs uppercase tracking-wide text-staging">
                            Staging
                          </Paragraph>
                        </TextLink>
                      </TooltipTrigger>
                      <TooltipContent className="flex items-center gap-2">
                        <LockOpenIcon className="size-4 text-indigo-500" />
                        Upgrade your plan to add a Staging environment.
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              </div>
              <FormError id={environmentIds.errorId}>{environmentIds.error}</FormError>
              <Hint>
                Dev environment variables specified here will be overridden by ones in your .env
                file when running locally.
              </Hint>
            </InputGroup>
            <InputGroup fullWidth>
              <FieldLayout showDeleteButton={false}>
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
              <VariableFields
                revealValues={revealAll}
                formId={form.id}
                formRef={form.ref}
                variablesFields={variables}
              />
              <FormError id={variables.errorId}>{variables.error}</FormError>
            </InputGroup>

            <FormError>{form.error}</FormError>
            <FormButtons
              confirmButton={
                <div className="flex flex-row-reverse items-center gap-2">
                  <Button
                    type="submit"
                    variant="primary/medium"
                    disabled={isLoading}
                    name="override"
                    value="false"
                  >
                    {isLoading ? "Saving" : "Save"}
                  </Button>
                  <Button
                    variant="secondary/medium"
                    disabled={isLoading}
                    name="override"
                    value="true"
                  >
                    {isLoading ? "Overriding" : "Override"}
                  </Button>
                </div>
              }
              cancelButton={
                <LinkButton
                  to={v3EnvironmentVariablesPath(organization, project)}
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

function FieldLayout({
  children,
  showDeleteButton,
}: {
  children: React.ReactNode;
  showDeleteButton: boolean;
}) {
  return (
    <div
      className={cn(
        "grid w-full gap-1.5",
        showDeleteButton ? "grid-cols-[1fr_1fr_2rem]" : "grid-cols-[1fr_1fr]"
      )}
    >
      {children}
    </div>
  );
}

function VariableFields({
  revealValues,
  formId,
  variablesFields,
  formRef,
}: {
  revealValues: boolean;
  formId?: string;
  variablesFields: FieldConfig<any>;
  formRef: RefObject<HTMLFormElement>;
}) {
  const {
    items,
    append,
    update,
    delete: remove,
    insertAfter,
  } = useList<Variable>([{ key: "", value: "" }]);

  const handlePaste = useCallback((index: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const clipboardData = e.clipboardData;
    if (!clipboardData) return;

    let text = clipboardData.getData("text");
    if (!text) return;

    const variables = dotenv.parse(text);
    const keyValuePairs = Object.entries(variables).map(([key, value]) => ({ key, value }));

    //do the default paste
    if (keyValuePairs.length === 0) return;

    //prevent default pasting
    e.preventDefault();

    const [firstPair, ...rest] = keyValuePairs;
    update(index, firstPair);

    for (const pair of rest) {
      requestIntent(formRef.current ?? undefined, list.append(variablesFields.name));
    }
    insertAfter(index, rest);
  }, []);

  const fields = useFieldList(formRef, variablesFields);

  return (
    <>
      {fields.map((field, index) => {
        const item = items[index];

        return (
          <VariableField
            formId={formId}
            key={index}
            index={index}
            value={item}
            onChange={(value) => update(index, value)}
            onPaste={(e) => handlePaste(index, e)}
            onDelete={() => {
              requestIntent(
                formRef.current ?? undefined,
                list.remove(variablesFields.name, { index })
              );
              remove(index);
            }}
            showDeleteButton={items.length > 1}
            showValue={revealValues}
            config={field}
          />
        );
      })}
      <div className={cn("flex items-center justify-between gap-4", items.length > 1 && "pr-10")}>
        <Paragraph variant="extra-small">
          Tip: Paste your .env into this form to populate it.
        </Paragraph>
        <Button
          variant="tertiary/medium"
          className="w-fit"
          type="button"
          onClick={() => {
            requestIntent(formRef.current ?? undefined, list.append(variablesFields.name));
            append([{ key: "", value: "" }]);
          }}
          LeadingIcon={PlusIcon}
        >
          Add another
        </Button>
      </div>
    </>
  );
}

function VariableField({
  formId,
  index,
  value,
  onChange,
  onPaste,
  onDelete,
  showDeleteButton,
  showValue,
  config,
}: {
  formId?: string;
  index: number;
  value: Variable;
  onChange: (value: Variable) => void;
  onPaste: (e: React.ClipboardEvent<HTMLInputElement>) => void;
  onDelete: () => void;
  showDeleteButton: boolean;
  showValue: boolean;
  config: FieldConfig<Variable>;
}) {
  const ref = useRef<HTMLFieldSetElement>(null);
  const fields = useFieldset(ref, config);
  const baseFieldName = `variables[${index}]`;

  return (
    <fieldset ref={ref}>
      <FieldLayout showDeleteButton={showDeleteButton}>
        <Input
          id={`${formId}-${baseFieldName}.key`}
          name={`${baseFieldName}.key`}
          placeholder="e.g. CLIENT_KEY"
          value={value.key}
          onChange={(e) => onChange({ ...value, key: e.currentTarget.value })}
          autoFocus={index === 0}
          onPaste={onPaste}
        />
        <Input
          id={`${formId}-${baseFieldName}.value`}
          name={`${baseFieldName}.value`}
          type={showValue ? "text" : "password"}
          placeholder="Not set"
          value={value.value}
          onChange={(e) => onChange({ ...value, value: e.currentTarget.value })}
        />
        {showDeleteButton && (
          <Button
            variant="minimal/medium"
            type="button"
            onClick={() => onDelete()}
            LeadingIcon={XMarkIcon}
          />
        )}
      </FieldLayout>
      <div className="space-y-2">
        <FormError id={fields.key.errorId}>{fields.key.error}</FormError>
        <FormError id={fields.value.errorId}>{fields.value.error}</FormError>
      </div>
    </fieldset>
  );
}
