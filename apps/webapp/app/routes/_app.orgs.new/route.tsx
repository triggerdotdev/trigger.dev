import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import type { ActionFunction, LoaderFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { createOrganization } from "~/models/organization.server";
import { NewOrganizationPresenter } from "~/presenters/NewOrganizationPresenter.server";
import { commitCurrentProjectSession, setCurrentProjectId } from "~/services/currentProject.server";
import { requireUserId } from "~/services/session.server";
import { projectPath, rootPath } from "~/utils/pathBuilder";

const schema = z.object({
  orgName: z.string().min(3).max(50),
  projectName: z.string().min(3).max(50),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const presenter = new NewOrganizationPresenter();
  const { hasOrganizations } = await presenter.call({ userId });

  return typedjson({
    hasOrganizations,
  });
};

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    const organization = await createOrganization({
      title: submission.value.orgName,
      userId,
      projectName: submission.value.projectName,
    });

    const project = organization.projects[0];
    const session = await setCurrentProjectId(project.id, request);

    return redirect(projectPath(organization, project), {
      headers: {
        "Set-Cookie": await commitCurrentProjectSession(session),
      },
    });
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function NewOrganizationPage() {
  const { hasOrganizations } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();

  const [form, { orgName, projectName }] = useForm({
    id: "create-organization",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  return (
    <MainCenteredContainer>
      <div>
        <FormTitle LeadingIcon="organization" title="Create a new Organization" />
        <Form method="post" {...form.props}>
          <Fieldset>
            <InputGroup>
              <Label htmlFor={orgName.id}>Organization name</Label>
              <Input
                {...conform.input(orgName, { type: "text" })}
                placeholder="Your Organization name"
                icon="organization"
              />
              <Hint>E.g. your company name or your workspace name.</Hint>
              <FormError id={orgName.errorId}>{orgName.error}</FormError>
            </InputGroup>
            <InputGroup>
              <Label htmlFor={projectName.id}>Project name</Label>
              <Input
                {...conform.input(projectName, { type: "text" })}
                placeholder="Your Project name"
                icon="folder"
              />
              <Hint>Your Jobs will live inside this Project.</Hint>
              <FormError id={projectName.errorId}>{projectName.error}</FormError>
            </InputGroup>

            <FormButtons
              confirmButton={
                <Button type="submit" variant={"primary/small"} TrailingIcon="arrow-right">
                  Create
                </Button>
              }
              cancelButton={
                hasOrganizations ? (
                  <LinkButton to={rootPath()} variant={"secondary/small"}>
                    Cancel
                  </LinkButton>
                ) : null
              }
            />
          </Fieldset>
        </Form>
      </div>
    </MainCenteredContainer>
  );
}
