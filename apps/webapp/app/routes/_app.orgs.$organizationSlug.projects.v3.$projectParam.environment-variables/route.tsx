import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import {
  BookOpenIcon,
  InformationCircleIcon,
  LockOpenIcon,
  PencilSquareIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/20/solid";
import { ArrowUpCircleIcon } from "@heroicons/react/24/outline";
import { Form, Outlet, useActionData, useNavigation } from "@remix-run/react";
import {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  json,
  redirectDocument,
} from "@remix-run/server-runtime";
import { RuntimeEnvironment } from "@trigger.dev/database";
import { Fragment, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { InlineCode } from "~/components/code/InlineCode";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
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
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { prisma } from "~/db.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { redirectWithSuccessMessage } from "~/models/message.server";
import {
  EnvironmentVariableWithSetValues,
  EnvironmentVariablesPresenter,
} from "~/presenters/v3/EnvironmentVariablesPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import {
  ProjectParamSchema,
  docsPath,
  v3BillingPath,
  v3EnvironmentVariablesPath,
  v3NewEnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  DeleteEnvironmentVariable,
  EditEnvironmentVariable,
} from "~/v3/environmentVariables/repository";

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
  z.object({ action: z.literal("edit"), key: z.string(), ...EditEnvironmentVariable.shape }),
  z.object({ action: z.literal("delete"), key: z.string(), ...DeleteEnvironmentVariable.shape }),
]);

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

  switch (submission.value.action) {
    case "edit": {
      const repository = new EnvironmentVariablesRepository(prisma);
      const result = await repository.edit(project.id, submission.value);

      if (!result.success) {
        submission.error.key = result.error;
        return json(submission);
      }

      //use redirectDocument because it reloads the page
      return redirectDocument(
        v3EnvironmentVariablesPath({ slug: organizationSlug }, { slug: projectParam }),
        {
          headers: {
            refresh: "true",
          },
        }
      );
    }
    case "delete": {
      const repository = new EnvironmentVariablesRepository(prisma);
      const result = await repository.delete(project.id, submission.value);

      if (!result.success) {
        submission.error.key = result.error;
        return json(submission);
      }

      return redirectWithSuccessMessage(
        v3EnvironmentVariablesPath({ slug: organizationSlug }, { slug: projectParam }),
        request,
        `Deleted ${submission.value.key} environment variable`
      );
    }
  }
};

export default function Page() {
  const [revealAll, setRevealAll] = useState(false);
  const { environmentVariables, environments, hasStaging } = useTypedLoaderData<typeof loader>();
  const project = useProject();
  const organization = useOrganization();

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
                to={v3NewEnvironmentVariablesPath(organization, project)}
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
              <TableHeaderCell>Key</TableHeaderCell>
              {environments.map((environment) => (
                <TableHeaderCell key={environment.id}>
                  <EnvironmentLabel environment={environment} />
                </TableHeaderCell>
              ))}
              <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
            </TableHeader>
            <TableBody>
              {environmentVariables.length > 0 ? (
                environmentVariables.map((variable) => (
                  <TableRow key={variable.id}>
                    <TableCell>{variable.key}</TableCell>
                    {environments.map((environment) => {
                      const value = variable.values[environment.id]?.value;

                      if (!value) {
                        return <TableCell key={environment.id}>Not set</TableCell>;
                      }
                      return (
                        <TableCell key={environment.id}>
                          <ClipboardField
                            className="-ml-2"
                            secure={!revealAll}
                            value={value}
                            variant={"secondary/small"}
                          />
                        </TableCell>
                      );
                    })}
                    <TableCellMenu
                      isSticky
                      popoverContent={
                        <>
                          <EditEnvironmentVariablePanel
                            environments={environments}
                            variable={variable}
                            revealAll={revealAll}
                          />
                          <DeleteEnvironmentVariableButton variable={variable} />
                        </>
                      }
                    ></TableCellMenu>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={environments.length + 2}>
                    <div className="flex flex-col items-center justify-center gap-y-4 py-8">
                      <Header2>You haven't set any environment variables yet.</Header2>
                      <LinkButton
                        to={v3NewEnvironmentVariablesPath(organization, project)}
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

          <div className="z-10 -mt-px flex w-full flex-wrap justify-between border-t border-grid-dimmed">
            <InfoPanel icon={InformationCircleIcon} variant="minimal" panelClassName="max-w-fit">
              Dev environment variables specified here will be overridden by ones in your .env file
              when running locally.
            </InfoPanel>
            {!hasStaging && (
              <div className="flex items-center gap-2 pl-3 pr-2">
                <LockOpenIcon className="size-5 min-w-5 text-indigo-500" />
                <Paragraph variant="small" className="text-text-bright">
                  Upgrade to add a Staging environment
                </Paragraph>
                <LinkButton
                  to={v3BillingPath(organization)}
                  variant="secondary/small"
                  LeadingIcon={ArrowUpCircleIcon}
                >
                  Upgrade
                </LinkButton>
              </div>
            )}
          </div>
        </div>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}

function EditEnvironmentVariablePanel({
  variable,
  environments,
  revealAll,
}: {
  variable: EnvironmentVariableWithSetValues;
  environments: Pick<RuntimeEnvironment, "id" | "type">[];
  revealAll: boolean;
}) {
  const [reveal, setReveal] = useState(revealAll);

  const [isOpen, setIsOpen] = useState(false);
  const lastSubmission = useActionData();
  const navigation = useNavigation();

  const hiddenValues = Object.values(variable.values).filter(
    (value) => !environments.map((e) => e.id).includes(value.environment.id)
  );

  const isLoading =
    navigation.state !== "idle" &&
    navigation.formMethod === "post" &&
    navigation.formData?.get("action") === "edit";

  const [form, { id }] = useForm({
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
        <DialogHeader>Edit {variable.key}</DialogHeader>
        <Form method="post" {...form.props}>
          <input type="hidden" name="action" value="edit" />
          <input type="hidden" name="id" value={variable.id} />
          <input type="hidden" name="key" value={variable.key} />
          {hiddenValues.map((value, index) => (
            <Fragment key={index}>
              <input
                type="hidden"
                name={`values[${index}].environmentId`}
                value={value.environment.id}
              />
              <input type="hidden" name={`values[${index}].value`} value={value.value} />
            </Fragment>
          ))}
          <FormError id={id.errorId}>{id.error}</FormError>
          <Fieldset>
            <InputGroup fullWidth className="mb-5 mt-2">
              <Label>Key</Label>
              <InlineCode variant="base" className="pl-1.5">
                {variable.key}
              </InlineCode>
            </InputGroup>
          </Fieldset>
          <Fieldset>
            <InputGroup fullWidth>
              <div className="flex justify-between gap-1">
                <Label>Values</Label>
                <Switch
                  variant="small"
                  label="Reveal"
                  checked={reveal}
                  onCheckedChange={(e) => setReveal(e.valueOf())}
                />
              </div>
              <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-2">
                {environments.map((environment, index) => {
                  const value = variable.values[environment.id]?.value;
                  index += hiddenValues.length;
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
                        <EnvironmentLabel environment={environment} size="large" className="px-2" />
                      </label>
                      <Input
                        name={`values[${index}].value`}
                        placeholder="Not set"
                        defaultValue={value}
                        type={reveal ? "text" : "password"}
                      />
                    </Fragment>
                  );
                })}
              </div>
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
      <Button
        name="action"
        value="delete"
        type="submit"
        variant="small-menu-item"
        fullWidth
        textAlignLeft
        LeadingIcon={TrashIcon}
        leadingIconClassName="text-rose-500 group-hover/button:text-text-bright transition-colors"
        className="transition-colors group-hover/button:bg-error"
      >
        {isLoading ? "Deleting" : "Delete"}
      </Button>
    </Form>
  );
}
