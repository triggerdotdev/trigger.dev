import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  BookOpenIcon,
  InformationCircleIcon,
  LockClosedIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { Form, type MetaFunction, Outlet, useActionData, useNavigation } from "@remix-run/react";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  json,
  redirectDocument,
} from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { InfoPanel } from "~/components/primitives/InfoPanel";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Switch } from "~/components/primitives/Switch";
import {
  Table,
  TableBody,
  TableCell,
  TableCellMenu,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { prisma } from "~/db.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import {
  type EnvironmentVariableWithSetValues,
  EnvironmentVariablesPresenter,
} from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  EnvironmentParamSchema,
  ProjectParamSchema,
  docsPath,
  v3EnvironmentVariablesPath,
  v3NewEnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  DeleteEnvironmentVariableValue,
  EditEnvironmentVariableValue,
} from "~/v3/environmentVariables/repository";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Environment variables | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam } = ProjectParamSchema.parse(params);

  try {
    const presenter = new EnvironmentVariablesPresenter();
    const { environmentVariables, environments, hasStaging } = await presenter.call({
      userId,
      projectSlug: projectParam,
    });

    return typedjson({
      environmentVariables,
      environments,
      hasStaging,
    });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), ...EditEnvironmentVariableValue.shape }),
  z.object({
    action: z.literal("delete"),
    key: z.string(),
    ...DeleteEnvironmentVariableValue.shape,
  }),
]);

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

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

  switch (submission.value.action) {
    case "edit": {
      const repository = new EnvironmentVariablesRepository(prisma);
      const result = await repository.editValue(project.id, submission.value);

      if (!result.success) {
        submission.error.key = result.error;
        return json(submission);
      }

      //use redirectDocument because it reloads the page
      return redirectDocument(
        v3EnvironmentVariablesPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: envParam }
        ),
        {
          headers: {
            refresh: "true",
          },
        }
      );
    }
    case "delete": {
      const repository = new EnvironmentVariablesRepository(prisma);
      const result = await repository.deleteValue(project.id, submission.value);

      if (!result.success) {
        submission.error.key = result.error;
        return json(submission);
      }

      return redirectWithSuccessMessage(
        v3EnvironmentVariablesPath(
          { slug: organizationSlug },
          { slug: projectParam },
          { slug: envParam }
        ),
        request,
        `Deleted ${submission.value.key} environment variable`
      );
    }
  }
};

export default function Page() {
  const [revealAll, setRevealAll] = useState(false);
  const { environmentVariables, environments } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  // Add isFirst and isLast to each environment variable
  // They're set based on if they're the first or last time that `key` has been seen in the list
  const groupedEnvironmentVariables = useMemo(() => {
    // Create a map to track occurrences of each key
    const keyOccurrences = new Map<string, number>();

    // First pass: count total occurrences of each key
    environmentVariables.forEach((variable) => {
      keyOccurrences.set(variable.key, (keyOccurrences.get(variable.key) || 0) + 1);
    });

    // Second pass: add isFirstTime, isLastTime, and occurrences flags
    const seenKeys = new Set<string>();
    const currentOccurrences = new Map<string, number>();

    return environmentVariables.map((variable) => {
      // Track current occurrence number for this key
      const currentCount = (currentOccurrences.get(variable.key) || 0) + 1;
      currentOccurrences.set(variable.key, currentCount);

      const totalOccurrences = keyOccurrences.get(variable.key) || 1;
      const isFirstTime = !seenKeys.has(variable.key);
      const isLastTime = currentCount === totalOccurrences;

      if (isFirstTime) {
        seenKeys.add(variable.key);
      }

      return {
        ...variable,
        isFirstTime,
        isLastTime,
        occurences: totalOccurrences,
      };
    });
  }, [environmentVariables]);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Environment variables" />
        <PageAccessories>
          <LinkButton
            LeadingIcon={BookOpenIcon}
            to={docsPath("v3/deploy-environment-variables")}
            variant="docs/small"
          >
            Environment variables docs
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <div className={cn("flex h-full flex-col")}>
          {environmentVariables.length > 0 && (
            <div className="flex items-center justify-end gap-2 px-2 py-2">
              <Switch
                variant="small"
                label="Reveal values"
                checked={revealAll}
                onCheckedChange={(e) => setRevealAll(e.valueOf())}
              />
              <LinkButton
                to={v3NewEnvironmentVariablesPath(organization, project, environment)}
                variant="primary/small"
                LeadingIcon={PlusIcon}
                shortcut={{ key: "n" }}
              >
                Add new
              </LinkButton>
            </div>
          )}
          <Table containerClassName={cn(environmentVariables.length === 0 && "border-t-0")}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell className="w-[25%]">Key</TableHeaderCell>
                <TableHeaderCell className="w-[55%]">Value</TableHeaderCell>
                <TableHeaderCell className="w-[20%]">Environment</TableHeaderCell>
                <TableHeaderCell hiddenLabel className="pl-24">
                  Actions
                </TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groupedEnvironmentVariables.length > 0 ? (
                groupedEnvironmentVariables.map((variable) => {
                  const cellClassName = "py-2";
                  let borderedCellClassName = "";

                  if (variable.occurences > 1) {
                    borderedCellClassName =
                      "relative after:absolute after:bottom-0 after:left-0 after:right-0 after:h-px after:bg-grid-bright group-hover/table-row:after:bg-grid-bright group-hover/table-row:before:bg-grid-bright";
                    if (variable.isLastTime) {
                      borderedCellClassName = "";
                    } else if (variable.isFirstTime) {
                    }
                  } else {
                  }

                  return (
                    <TableRow
                      key={`${variable.id}-${variable.environment.id}`}
                      className={
                        variable.isLastTime ? "after:bg-charcoal-600" : "after:bg-transparent"
                      }
                    >
                      <TableCell className={cellClassName}>
                        {variable.isFirstTime ? (
                          <CopyableText value={variable.key} className="font-mono" />
                        ) : null}
                      </TableCell>
                      <TableCell
                        className={cn(cellClassName, borderedCellClassName, "after:left-3")}
                      >
                        {variable.isSecret ? (
                          <SimpleTooltip
                            button={
                              <div className="flex items-center gap-x-1">
                                <LockClosedIcon className="size-3 text-text-dimmed" />
                                <span className="text-xs text-text-dimmed">Secret</span>
                              </div>
                            }
                            content="This variable is secret and cannot be revealed."
                          />
                        ) : (
                          <ClipboardField
                            secure={!revealAll}
                            value={variable.value}
                            variant={"secondary/small"}
                            fullWidth={true}
                          />
                        )}
                      </TableCell>

                      <TableCell className={cn(cellClassName, borderedCellClassName)}>
                        <EnvironmentCombo environment={variable.environment} className="text-sm" />
                      </TableCell>
                      <TableCellMenu
                        className={cn(cellClassName, borderedCellClassName)}
                        isSticky
                        hiddenButtons={
                          <>
                            <EditEnvironmentVariablePanel
                              variable={variable}
                              revealAll={revealAll}
                            />
                            <DeleteEnvironmentVariableButton variable={variable} />
                          </>
                        }
                      />
                    </TableRow>
                  );
                })
              ) : (
                <TableRow>
                  <TableCell colSpan={4}>
                    <div className="flex flex-col items-center justify-center gap-y-4 py-8">
                      <Header2>You haven't set any environment variables yet.</Header2>
                      <LinkButton
                        to={v3NewEnvironmentVariablesPath(organization, project, environment)}
                        variant="primary/medium"
                        LeadingIcon={PlusIcon}
                        shortcut={{ key: "n" }}
                      >
                        Add new
                      </LinkButton>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>

          <div className="-mt-px w-full border-t border-grid-dimmed">
            <InfoPanel icon={InformationCircleIcon} variant="minimal" panelClassName="max-w-fit">
              Dev environment variables specified here will be overridden by ones in your .env file
              when running locally.
            </InfoPanel>
          </div>
        </div>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}

function EditEnvironmentVariablePanel({
  variable,
  revealAll,
}: {
  variable: EnvironmentVariableWithSetValues;
  revealAll: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "edit";

  const [form, { id, environmentId, value }] = useForm({
    id: "edit-environment-variable",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="small-menu-item" LeadingIcon={PencilSquareIcon} fullWidth textAlignLeft>
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>Edit environment variable</DialogHeader>
        <Form method="post" {...form.props}>
          <input type="hidden" name="action" value="edit" />
          <input {...conform.input(id, { type: "hidden" })} value={variable.id} />
          <input
            {...conform.input(environmentId, { type: "hidden" })}
            value={variable.environment.id}
          />
          <FormError id={id.errorId}>{id.error}</FormError>
          <FormError id={environmentId.errorId}>{environmentId.error}</FormError>
          <Fieldset>
            <InputGroup fullWidth className="mt-2 gap-0">
              <Label>Key</Label>
              <CopyableText value={variable.key} className="w-fit font-mono text-sm" />
            </InputGroup>

            <InputGroup fullWidth>
              <Label>Environment</Label>
              <EnvironmentCombo environment={variable.environment} className="text-sm" />
            </InputGroup>

            <InputGroup fullWidth>
              <Label>Value</Label>
              <Input
                {...conform.input(value, { type: "text" })}
                placeholder={variable.isSecret ? "Set new secret value" : "Not set"}
                defaultValue={variable.value}
                type={"text"}
              />
              <FormError id={value.errorId}>{value.error}</FormError>
            </InputGroup>

            <FormError>{form.error}</FormError>

            <FormButtons
              confirmButton={
                <Button type="submit" variant="primary/medium" disabled={isLoading}>
                  {isLoading ? "Saving…" : "Save"}
                </Button>
              }
              cancelButton={
                <Button onClick={() => setIsOpen(false)} variant="tertiary/medium" type="button">
                  Cancel
                </Button>
              }
            />
          </Fieldset>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteEnvironmentVariableButton({
  variable,
}: {
  variable: EnvironmentVariableWithSetValues;
}) {
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "delete";

  const [form, { id }] = useForm({
    id: "delete-environment-variable",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onSubmit",
  });

  return (
    <Form method="post" {...form.props}>
      <input type="hidden" name="id" value={variable.id} />
      <input type="hidden" name="key" value={variable.key} />
      <input type="hidden" name="environmentId" value={variable.environment.id} />
      <Button
        name="action"
        value="delete"
        type="submit"
        variant="small-menu-item"
        fullWidth
        textAlignLeft
        LeadingIcon={TrashIcon}
        leadingIconClassName="text-rose-500 group-hover/button:text-text-bright transition-colors"
        className="ml-0.5 transition-colors group-hover/button:bg-error"
      >
        {isLoading ? "Deleting" : "Delete"}
      </Button>
    </Form>
  );
}
