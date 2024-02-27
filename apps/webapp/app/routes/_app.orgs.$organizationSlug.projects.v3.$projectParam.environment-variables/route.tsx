import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { PencilSquareIcon, TrashIcon } from "@heroicons/react/20/solid";
import { Form, Outlet, useActionData, useNavigation } from "@remix-run/react";
import {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  json,
  redirect,
  redirectDocument,
} from "@remix-run/server-runtime";
import { RuntimeEnvironment } from "@trigger.dev/database";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { EnvironmentLabel } from "~/components/environments/EnvironmentLabel";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { Dialog, DialogContent, DialogHeader, DialogTrigger } from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import {
  PageButtons,
  PageHeader,
  PageTitle,
  PageTitleRow,
} from "~/components/primitives/PageHeader";
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
import { Handle } from "~/utils/handle";
import {
  ProjectParamSchema,
  docsPath,
  v3EnvironmentVariablesPath,
  v3NewEnvironmentVariablesPath,
} from "~/utils/pathBuilder";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";
import {
  CreateEnvironmentVariable,
  EditEnvironmentVariable,
  DeleteEnvironmentVariable,
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
      const result = await repository.edit(project.id, userId, submission.value);

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
      const result = await repository.delete(project.id, userId, submission.value);

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

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="Environments & API Keys" />,
};

export default function Page() {
  const [revealAll, setRevealAll] = useState(false);
  const { environmentVariables, environments } = useTypedLoaderData<typeof loader>();
  const project = useProject();
  const organization = useOrganization();

  return (
    <PageContainer>
      <PageHeader>
        <PageTitleRow>
          <PageTitle title="Environment variables" />
          <PageButtons>
            <LinkButton
              LeadingIcon={"docs"}
              to={docsPath("/documentation/concepts/environments-endpoints#environments")}
              variant="secondary/small"
            >
              Environment variables docs
            </LinkButton>
          </PageButtons>
        </PageTitleRow>
      </PageHeader>
      <PageBody>
        <div className={cn("flex h-full flex-col gap-3")}>
          <div className="flex items-center justify-end gap-2">
            <Switch
              variant="small"
              label="Reveal values"
              checked={revealAll}
              onCheckedChange={(e) => setRevealAll(e.valueOf())}
            />
            <LinkButton
              to={v3NewEnvironmentVariablesPath(organization, project)}
              variant="primary/small"
              LeadingIcon="plus"
              leadingIconClassName="text-white"
            >
              New environment variable
            </LinkButton>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Key</TableHeaderCell>
                {environments.map((environment) => (
                  <TableHeaderCell key={environment.id}>
                    <EnvironmentLabel environment={environment} />
                  </TableHeaderCell>
                ))}
                <TableHeaderCell hiddenLabel>Actions</TableHeaderCell>
              </TableRow>
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
                            className="w-full max-w-none"
                            secure={!revealAll}
                            value={value}
                            variant={"tertiary/small"}
                          />
                        </TableCell>
                      );
                    })}
                    <TableCellMenu isSticky>
                      <EditEnvironmentVariablePanel
                        environments={environments}
                        variable={variable}
                      />
                      <DeleteEnvironmentVariableButton variable={variable} />
                    </TableCellMenu>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={environments.length + 2}>
                    <div className="flex items-center justify-center">
                      <Paragraph>No environment variables have been set</Paragraph>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <Outlet />
      </PageBody>
    </PageContainer>
  );
}

function EditEnvironmentVariablePanel({
  variable,
  environments,
}: {
  variable: EnvironmentVariableWithSetValues;
  environments: Pick<RuntimeEnvironment, "id" | "type">[];
}) {
  const lastSubmission = useActionData();
  const navigation = useNavigation();

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
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="small-menu-item"
          LeadingIcon={PencilSquareIcon}
          leadingIconClassName="text-slate-500"
          className="text-xs"
          fullWidth
          textAlignLeft
        >
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          Edit <strong>{variable.key}</strong>
        </DialogHeader>
        <Form method="post" {...form.props}>
          <input type="hidden" name="action" value="edit" />
          <input type="hidden" name="id" value={variable.id} />
          <input type="hidden" name="key" value={variable.key} />
          <FormError id={id.errorId}>{id.error}</FormError>
          <Fieldset>
            <InputGroup>
              <Label>Key</Label>
              <Header2>{variable.key}</Header2>
            </InputGroup>
          </Fieldset>
          <Fieldset>
            <InputGroup>
              <Label>Values</Label>
              <div className="flex flex-col gap-2">
                {environments.map((environment, index) => {
                  const value = variable.values[environment.id]?.value;
                  return (
                    <div key={environment.id}>
                      <input
                        type="hidden"
                        name={`values[${index}].environmentId`}
                        value={environment.id}
                      />
                      <Input
                        name={`values[${index}].value`}
                        placeholder="Not set"
                        defaultValue={value}
                        icon={<EnvironmentLabel environment={environment} />}
                      />
                    </div>
                  );
                })}
              </div>
            </InputGroup>
          </Fieldset>

          <FormError>{form.error}</FormError>

          <FormButtons
            className="m-0 w-max"
            confirmButton={
              <Button type="submit" variant="primary/medium" disabled={isLoading}>
                {isLoading ? "Saving" : "Edit"}
              </Button>
            }
          />
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
        LeadingIcon={TrashIcon}
        leadingIconClassName="text-rose-500"
        className="text-xs"
      >
        {isLoading ? "Deleting" : "Delete"}
      </Button>
    </Form>
  );
}
