import { FolderIcon } from "@heroicons/react/24/solid";
import { Form } from "@remix-run/react";
import { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import {
  redirect,
  typedjson,
  useTypedActionData,
  useTypedLoaderData,
} from "remix-typedjson";
import invariant from "tiny-invariant";
import { z } from "zod";
import { OctoKitty } from "~/components/GitHubLoginButton";
import { Container } from "~/components/layout/Container";
import { Panel } from "~/components/layout/Panel";
import { PanelWarning } from "~/components/layout/PanelWarning";
import { StepNumber } from "~/components/onboarding/StepNumber";
import { PrimaryButton, PrimaryLink } from "~/components/primitives/Buttons";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Select } from "~/components/primitives/Select";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { Title } from "~/components/primitives/text/Title";
import { TemplateCard } from "~/components/templates/TemplateCard";
import { useCurrentEnvironment } from "~/hooks/useEnvironments";
import { useCurrentOrganization } from "~/hooks/useOrganizations";
import { WorkflowStartPresenter } from "~/presenters/workflowStartPresenter.server";
import { requireUserId } from "~/services/session.server";
import { AddTemplateService } from "~/services/templates/addTemplate.server";
import { ConnectedToGithub, DeployBlankState } from "./templates/$templateId";

export async function loader({ params, request }: LoaderArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = z
    .object({ organizationSlug: z.string() })
    .parse(params);

  const { templateId } = z
    .object({ templateId: z.string().optional() })
    .parse(Object.fromEntries(new URL(request.url).searchParams));

  const presenter = new WorkflowStartPresenter();

  return typedjson(
    await presenter.data({ organizationSlug, userId, templateId })
  );
}

export async function action({ params, request }: ActionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = z
    .object({ organizationSlug: z.string() })
    .parse(params);
  const payload = Object.fromEntries(await request.formData());

  const service = new AddTemplateService();

  const validation = service.validate(payload);

  if (!validation.success) {
    return typedjson(
      {
        type: "validationError" as const,
        errors: validation.error.issues,
      },
      { status: 422 }
    );
  }

  const result = await service.call({
    data: validation.data,
    organizationSlug,
    userId,
  });

  if (result.type === "error") {
    return typedjson(
      {
        type: "serviceError" as const,
        message: result.message,
      },
      { status: 422 }
    );
  }

  return redirect(`/orgs/${organizationSlug}/templates/${result.template.id}`);
}

export default function AddTemplatePage() {
  const { appAuthorizations, templates, template } =
    useTypedLoaderData<typeof loader>();
  const environment = useCurrentEnvironment();
  const currentOrganization = useCurrentOrganization();
  invariant(currentOrganization, "Organization must be defined");
  invariant(environment, "Environment must be defined");

  const actionData = useTypedActionData<typeof action>();

  return (
    <Container>
      <div className="grid grid-cols-[minmax(0,_1fr)_minmax(0,_1fr)_minmax(0,_1fr)_300px] gap-4">
        <Form method="post" className="col-span-3 max-w-4xl">
          <Title>You're almost done</Title>

          {actionData?.type === "serviceError" ? (
            <PanelWarning
              message={actionData.message}
              className="mb-4"
            ></PanelWarning>
          ) : actionData?.type === "validationError" ? (
            <PanelWarning
              message="There was a problem with your submission."
              className="mb-4"
            ></PanelWarning>
          ) : (
            <></>
          )}

          {appAuthorizations.length === 0 ? (
            <>
              <ConnectToGithub />
              <ConfigureGithub />
            </>
          ) : (
            <ConnectedToGithub />
          )}

          {template ? (
            <SubTitle className="flex items-center">
              <StepNumber active stepNumber="2" />
              Where should we create the new repository?
            </SubTitle>
          ) : (
            <SubTitle className="flex items-center">
              <StepNumber active stepNumber="2" />
              Where should we create the new repository?
            </SubTitle>
          )}
          <Panel className="!p-4">
            <div className="mb-3 grid grid-cols-2 gap-4">
              <InputGroup>
                <Label htmlFor="appAuthorizationId">
                  Select a GitHub account
                </Label>
                <Select name="appAuthorizationId" required>
                  {appAuthorizations.map((appAuthorization) => (
                    <option
                      value={appAuthorization.id}
                      key={appAuthorization.id}
                    >
                      {appAuthorization.account.login}
                    </option>
                  ))}
                </Select>

                {actionData?.type === "validationError" && (
                  <FormError
                    errors={actionData.errors}
                    path={["appAuthorizationId"]}
                  />
                )}
              </InputGroup>

              {template ? (
                <input type="hidden" name="templateId" value={template.id} />
              ) : (
                <InputGroup>
                  <Label htmlFor="templateId">Choose a template</Label>

                  <Select name="templateId" required>
                    {templates.map((template) => (
                      <option value={template.id} key={template.id}>
                        {template.title}
                      </option>
                    ))}
                  </Select>

                  {actionData?.type === "validationError" && (
                    <FormError
                      errors={actionData.errors}
                      path={["templateId"]}
                    />
                  )}
                </InputGroup>
              )}
            </div>
            <div className="mb-4 grid grid-cols-2 gap-4">
              <InputGroup>
                <Label htmlFor="name">
                  Choose a repository name (required)
                </Label>

                <Input
                  id="name"
                  name="name"
                  placeholder={`e.g. ${
                    template
                      ? `trigger.dev-${template.slug}`
                      : `my-trigger.dev-workflows`
                  }`}
                  spellCheck={false}
                  className=""
                />

                {actionData?.type === "validationError" && (
                  <FormError errors={actionData.errors} path={["name"]} />
                )}
              </InputGroup>
              <div>
                <p className="mb-1 text-sm text-slate-500">
                  Set the repo as private
                </p>
                <div className="flex w-full items-center rounded bg-black/20 px-3 py-2.5">
                  <Label
                    htmlFor="private"
                    className="flex cursor-pointer items-center gap-2 text-sm text-slate-300"
                  >
                    <input
                      type="checkbox"
                      name="private"
                      id="private"
                      className="border-3 h-4 w-4 cursor-pointer rounded border-black bg-slate-200 transition hover:bg-slate-300 focus:outline-none"
                    />
                    Private repo
                  </Label>
                </div>
              </div>
            </div>
            <div className="flex justify-end">
              <PrimaryButton type="submit">Add Template</PrimaryButton>
            </div>
          </Panel>
          <DeployBlankState />
        </Form>
        {template && <TemplateCard template={template} />}
      </div>
    </Container>
  );
}

function ConnectToGithub() {
  return (
    <>
      <SubTitle className="flex items-center">
        <StepNumber active stepNumber="1" />
        Login with GitHub to get started
      </SubTitle>
      <Panel className="mb-6 flex h-56 items-center justify-center">
        <PrimaryLink to="../apps/github">
          <OctoKitty className="h-4 w-4" />
          Continue with GitHub
        </PrimaryLink>
      </Panel>
    </>
  );
}

function ConfigureGithub() {
  return (
    <>
      <div className="mt-6">
        <SubTitle className="flex items-center">
          <StepNumber stepNumber="2" />
          Configure GitHub
        </SubTitle>
        <Panel className="flex h-56 w-full max-w-4xl items-center justify-center gap-6">
          <OctoKitty className="h-10 w-10 text-slate-600" />
          <div className="h-[1px] w-16 border border-dashed border-slate-600"></div>
          <FolderIcon className="h-10 w-10 text-slate-600" />
        </Panel>
      </div>
    </>
  );
}
