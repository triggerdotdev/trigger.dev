import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { RadioGroup } from "@radix-ui/react-radio-group";
import type { ActionFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
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
import { RadioGroupItem } from "~/components/primitives/RadioButton";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/primitives/Select";
import { featuresForRequest } from "~/features.server";
import { useFeatures } from "~/hooks/useFeatures";
import { createOrganization } from "~/models/organization.server";
import { NewOrganizationPresenter } from "~/presenters/NewOrganizationPresenter.server";
import { commitCurrentProjectSession, setCurrentProjectId } from "~/services/currentProject.server";
import { requireUserId } from "~/services/session.server";
import { projectPath, rootPath, selectPlanPath } from "~/utils/pathBuilder";

const schema = z.object({
  orgName: z.string().min(3).max(50),
  projectName: z.string().min(3).max(50),
  projectVersion: z.enum(["v2", "v3"]),
  companySize: z.string().optional(),
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
      companySize: submission.value.companySize ?? null,
      projectVersion: submission.value.projectVersion,
    });

    const project = organization.projects[0];
    const session = await setCurrentProjectId(project.id, request);

    const { isManagedCloud } = featuresForRequest(request);

    const headers = {
      "Set-Cookie": await commitCurrentProjectSession(session),
    };

    if (isManagedCloud && submission.value.projectVersion === "v2") {
      return redirect(selectPlanPath(organization), {
        headers,
      });
    }

    return redirect(projectPath(organization, project), {
      headers,
    });
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function NewOrganizationPage() {
  const { hasOrganizations } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();
  const { isManagedCloud, v3Enabled } = useFeatures();
  const navigation = useNavigation();

  const [form, { orgName, projectName, projectVersion }] = useForm({
    id: "create-organization",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onSubmit",
    shouldValidate: "onSubmit",
  });

  const isLoading = navigation.state === "submitting" || navigation.state === "loading";

  return (
    <MainCenteredContainer className="max-w-[22rem]">
      <FormTitle LeadingIcon="organization" title="Create an Organization" />
      <Form method="post" {...form.props}>
        <Fieldset>
          <InputGroup>
            <Label htmlFor={orgName.id}>Organization name</Label>
            <Input
              {...conform.input(orgName, { type: "text" })}
              placeholder="Your Organization name"
              icon="organization"
              autoFocus
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
          {v3Enabled ? (
            <InputGroup>
              <Label htmlFor={projectVersion.id}>Project type</Label>
              <SelectGroup>
                <Select {...conform.input(projectVersion, { type: "select" })} defaultValue={"v2"}>
                  <SelectTrigger width="full" size="medium">
                    <SelectValue placeholder="Project type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="v2">Version 2</SelectItem>
                    <SelectItem value="v3">Version 3 (Developer Preview)</SelectItem>
                  </SelectContent>
                </Select>
              </SelectGroup>
              <FormError id={projectVersion.errorId}>{projectVersion.error}</FormError>
            </InputGroup>
          ) : (
            <input {...conform.input(projectVersion, { type: "hidden" })} value="v2" />
          )}
          {isManagedCloud && (
            <InputGroup>
              <Label htmlFor={projectName.id}>Number of employees</Label>
              <RadioGroup name="companySize" className="flex items-center justify-between gap-2">
                <RadioGroupItem
                  id="employees-1-5"
                  label="1-5"
                  value={"1-5"}
                  variant="button/small"
                  className="grow"
                />
                <RadioGroupItem
                  id="employees-6-49"
                  label="6-49"
                  value={"6-49"}
                  variant="button/small"
                  className="grow"
                />
                <RadioGroupItem
                  id="employees-50-99"
                  label="50-99"
                  value={"50-99"}
                  variant="button/small"
                  className="grow"
                />
                <RadioGroupItem
                  id="employees-100+"
                  label="100+"
                  value={"100+"}
                  variant="button/small"
                  className="grow"
                />
              </RadioGroup>
            </InputGroup>
          )}

          <FormButtons
            confirmButton={
              <Button type="submit" variant={"primary/small"} disabled={isLoading}>
                Create
              </Button>
            }
            cancelButton={
              hasOrganizations ? (
                <LinkButton to={rootPath()} variant={"tertiary/small"}>
                  Cancel
                </LinkButton>
              ) : null
            }
          />
        </Fieldset>
      </Form>
    </MainCenteredContainer>
  );
}
