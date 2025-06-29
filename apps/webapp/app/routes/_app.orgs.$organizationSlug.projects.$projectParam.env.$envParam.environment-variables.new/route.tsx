import {
  type FieldConfig,
  list,
  requestIntent,
  useFieldList,
  useFieldset,
  useForm,
} from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { LockClosedIcon, LockOpenIcon, PlusIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form, useNavigate, useNavigation } from "@remix-run/react";
import { type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import dotenv from "dotenv";
import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { redirect, typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
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
import { Paragraph } from "~/components/primitives/Paragraph";
import { Switch } from "~/components/primitives/Switch";
import { TextLink } from "~/components/primitives/TextLink";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { prisma } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useList } from "~/hooks/useList";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { EnvironmentVariablesPresenter } from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  ProjectParamSchema,
  v3BillingPath,
  v3EnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import { EnvironmentVariableKey } from "~/v3/environmentVariables/repository";
import { Select, SelectItem } from "~/components/primitives/Select";
import { isSubmissionResult } from "~/utils/conformTo";

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
  isSecret: z.preprocess((i) => {
    if (i === "true") return true;
    return false;
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
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value) {
    return typedjson(submission);
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
    submission.error.key = ["Project not found"];
    return typedjson(submission);
  }

  const repository = new EnvironmentVariablesRepository(prisma);
  const result = await repository.create(project.id, submission.value);

  if (!result.success) {
    if (result.variableErrors) {
      for (const { key, error } of result.variableErrors) {
        const index = submission.value.variables.findIndex((v) => v.key === key);

        if (index !== -1) {
          submission.error[`variables[${index}].key`] = [error];
        }
      }
    } else {
      submission.error.variables = [result.error];
    }

    return typedjson(submission);
  }

  return redirect(
    v3EnvironmentVariablesPath(
      { slug: organizationSlug },
      { slug: projectParam },
      { slug: envParam }
    )
  );
};

export default function Page() {
  const [isOpen, setIsOpen] = useState(false);
  const { environments, hasStaging } = useTypedLoaderData<typeof loader>();
  const _lastSubmission = useTypedActionData<typeof action>();
  const lastSubmission = isSubmissionResult(_lastSubmission) ? _lastSubmission : undefined;
  const navigation = useNavigation();
  const navigate = useNavigate();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [selectedEnvironmentIds, setSelectedEnvironmentIds] = useState<Set<string>>(new Set());
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>(undefined);

  const branchEnvironments = environments.filter((env) => env.branchName);
  const nonBranchEnvironments = environments.filter((env) => !env.branchName);
  const selectedEnvironments = environments.filter((env) => selectedEnvironmentIds.has(env.id));
  const previewIsSelected = selectedEnvironments.some(
    (env) => env.branchName !== null || env.type === "PREVIEW"
  );

  const isLoading = navigation.state !== "idle" && navigation.formMethod === "post";

  const [form, { environmentIds, variables }] = useForm({
    id: "create-environment-variables",
    lastSubmission,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onSubmit",
    defaultValue: {
      variables: [{ key: "", value: "" }],
    },
  });

  const handleEnvironmentChange = (
    environmentId: string,
    isChecked: boolean,
    environmentType?: string
  ) => {
    setSelectedEnvironmentIds((prev) => {
      const newSet = new Set(prev);

      if (isChecked) {
        if (environmentType === "PREVIEW") {
          // If PREVIEW is checked, clear all other selections including branches
          newSet.clear();

          newSet.add(environmentId);
        } else {
          // If a non-PREVIEW environment is checked, remove PREVIEW if it's selected
          const previewEnv = environments.find((env) => env.type === "PREVIEW");
          if (previewEnv) {
            newSet.delete(previewEnv.id);
          }
          newSet.add(environmentId);
          setSelectedBranchId(undefined);
        }
      } else {
        newSet.delete(environmentId);
      }

      return newSet;
    });
  };

  const handleBranchChange = (branchId: string) => {
    if (branchId === "all") {
      setSelectedBranchId(undefined);
    } else {
      setSelectedBranchId(branchId);
    }
  };

  const [revealAll, setRevealAll] = useState(true);

  useEffect(() => {
    setIsOpen(true);
  }, []);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(o) => {
        if (!o) {
          navigate(v3EnvironmentVariablesPath(organization, project, environment));
        }
      }}
    >
      <DialogContent className="p-0 pt-2.5 md:max-w-2xl lg:max-w-3xl">
        <DialogHeader className="px-4">New environment variables</DialogHeader>
        <Form method="post" {...form.props}>
          <Fieldset className="max-h-[70vh] overflow-y-auto p-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
            <InputGroup fullWidth>
              <Label>Environments</Label>
              {selectedBranchId ? (
                <input type="hidden" name="environmentIds" value={selectedBranchId} />
              ) : (
                Array.from(selectedEnvironmentIds).map((id) => (
                  <input key={id} type="hidden" name="environmentIds" value={id} />
                ))
              )}
              <div className="flex items-center gap-2">
                {nonBranchEnvironments.map((environment) => (
                  <CheckboxWithLabel
                    key={environment.id}
                    id={environment.id}
                    value={environment.id}
                    defaultChecked={selectedEnvironmentIds.has(environment.id)}
                    onChange={(isChecked) =>
                      handleEnvironmentChange(environment.id, isChecked, environment.type)
                    }
                    label={<EnvironmentLabel environment={environment} className="text-sm" />}
                    variant="button"
                  />
                ))}
                {!hasStaging && (
                  <>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <TextLink
                            to={v3BillingPath(organization)}
                            className="flex w-fit cursor-pointer items-center gap-2 rounded border border-dashed border-charcoal-600 py-2.5 pl-3 pr-4 transition hover:border-charcoal-500 hover:bg-charcoal-850"
                          >
                            <LockClosedIcon className="size-4 text-charcoal-500" />
                            <EnvironmentLabel
                              environment={{ type: "STAGING" }}
                              className="text-sm"
                            />
                          </TextLink>
                        </TooltipTrigger>
                        <TooltipContent className="flex items-center gap-2">
                          <LockOpenIcon className="size-4 text-indigo-500" />
                          Upgrade your plan to add a Staging environment.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger>
                          <TextLink
                            to={v3BillingPath(organization)}
                            className="flex w-fit cursor-pointer items-center gap-2 rounded border border-dashed border-charcoal-600 py-2.5 pl-3 pr-4 transition hover:border-charcoal-500 hover:bg-charcoal-850"
                          >
                            <LockClosedIcon className="size-4 text-charcoal-500" />
                            <EnvironmentLabel
                              environment={{ type: "PREVIEW" }}
                              className="text-sm"
                            />
                          </TextLink>
                        </TooltipTrigger>
                        <TooltipContent className="flex items-center gap-2">
                          <LockOpenIcon className="size-4 text-indigo-500" />
                          Upgrade your plan to add Preview branches.
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </>
                )}
              </div>
              <FormError id={environmentIds.errorId}>{environmentIds.error}</FormError>
              <Hint>
                Dev environment variables specified here will be overridden by ones in your .env
                file when running locally.
              </Hint>
            </InputGroup>

            {previewIsSelected && (
              <InputGroup fullWidth>
                <Label>Select branch</Label>
                <div className="flex items-center gap-1">
                  <Select
                    variant="tertiary/medium"
                    value={selectedBranchId ?? "all"}
                    setValue={handleBranchChange}
                    placeholder="All branches"
                    items={[{ id: "all", branchName: "All branches" }, ...branchEnvironments]}
                    className="w-fit min-w-52"
                    filter={{
                      keys: [
                        (item) => item.branchName?.replace(/\//g, " ").replace(/_/g, " ") ?? "",
                      ],
                    }}
                    text={(val) =>
                      val ? branchEnvironments.find((b) => b.id === val)?.branchName : null
                    }
                    dropdownIcon
                  >
                    {(matches) =>
                      matches?.map((env) => (
                        <SelectItem key={env.id} value={env.id}>
                          {env.branchName}
                        </SelectItem>
                      ))
                    }
                  </Select>
                  {selectedBranchId !== "all" && selectedBranchId !== undefined && (
                    <Button
                      variant="minimal/medium"
                      type="button"
                      onClick={() => setSelectedBranchId(undefined)}
                      LeadingIcon={XMarkIcon}
                    />
                  )}
                </div>
                <Hint>Select a branch to override variables in the Preview environment.</Hint>
              </InputGroup>
            )}

            <InputGroup className="w-auto">
              <Switch
                name="isSecret"
                variant="medium"
                defaultChecked={false}
                value="true"
                className="-ml-2 inline-flex w-fit"
                label={<span className="text-text-bright">Secret value</span>}
              />
              <Hint className="-mt-1">
                If enabled, you and your team will not be able to view the values after creation.
              </Hint>
            </InputGroup>
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
              <VariableFields
                revealValues={revealAll}
                formId={form.id}
                formRef={form.ref}
                variablesFields={variables}
              />
              <FormError id={variables.errorId}>{variables.error}</FormError>
            </InputGroup>

            <FormError>{form.error}</FormError>
          </Fieldset>
          <FormButtons
            className="px-4 pb-4"
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
                to={v3EnvironmentVariablesPath(organization, project, environment)}
                variant="tertiary/medium"
              >
                Cancel
              </LinkButton>
            }
          />
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function FieldLayout({ children }: { children: React.ReactNode }) {
  return <div className="grid w-full grid-cols-[1fr_1fr] gap-1.5">{children}</div>;
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
      <div className="flex items-center justify-between gap-4">
        <Paragraph variant="extra-small">
          Tip: Paste all your .env values at once into this form to populate it.
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
      <FieldLayout>
        <div className="space-y-2">
          <Input
            id={`${formId}-${baseFieldName}.key`}
            name={`${baseFieldName}.key`}
            placeholder="e.g. CLIENT_KEY"
            value={value.key}
            onChange={(e) => onChange({ ...value, key: e.currentTarget.value })}
            autoFocus={index === 0}
            onPaste={onPaste}
          />
          <FormError id={fields.key.errorId}>{fields.key.error}</FormError>
        </div>
        <div className={cn("flex items-start gap-1")}>
          <div className="grow space-y-2">
            <Input
              id={`${formId}-${baseFieldName}.value`}
              name={`${baseFieldName}.value`}
              type={showValue ? "text" : "password"}
              placeholder="Not set"
              value={value.value}
              onChange={(e) => onChange({ ...value, value: e.currentTarget.value })}
            />
            <FormError id={fields.value.errorId}>{fields.value.error}</FormError>
          </div>
          {showDeleteButton && (
            <Button
              variant="minimal/medium"
              type="button"
              onClick={() => onDelete()}
              LeadingIcon={XMarkIcon}
            />
          )}
        </div>
      </FieldLayout>
    </fieldset>
  );
}
