import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import type { ActionFunction } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData } from "@remix-run/react";
import invariant from "tiny-invariant";
import { z } from "zod";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { createProject } from "~/models/project.server";
import { requireUserId } from "~/services/session.server";
import { projectPath } from "~/utils/pathBuilder";

const schema = z.object({
  projectName: z
    .string()
    .min(3, "Project name must have at least 3 characters")
    .max(50),
});

export const action: ActionFunction = async ({ request, params }) => {
  const userId = await requireUserId(request);
  const { organizationSlug } = params;
  invariant(organizationSlug, "organizationSlug is required");

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    const project = await createProject({
      organizationSlug: organizationSlug,
      name: submission.value.projectName,
      userId,
    });

    return redirect(projectPath(project.organization, project));
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function NewOrganizationPage() {
  const lastSubmission = useActionData();

  const [form, { projectName }] = useForm({
    id: "create-project",
    lastSubmission,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
  });

  return (
    <MainCenteredContainer>
      <div>
        <FormTitle
          LeadingIcon="folder"
          title="Create a new Project"
          description="Create a new Project to help you organize the Jobs you create."
        />
        <Form method="post" {...form.props}>
          <Fieldset>
            <InputGroup>
              <Label htmlFor={projectName.id}>Project name</Label>
              <Input
                {...conform.input(projectName, { type: "text" })}
                placeholder="Your project name"
                icon="folder"
              />
              <FormError id={projectName.errorId}>
                {projectName.error}
              </FormError>
            </InputGroup>
            <FormButtons
              confirmButton={
                <Button
                  type="submit"
                  variant={"primary/small"}
                  TrailingIcon="arrow-right"
                >
                  Create
                </Button>
              }
            />
          </Fieldset>
        </Form>
      </div>
    </MainCenteredContainer>
  );
}
