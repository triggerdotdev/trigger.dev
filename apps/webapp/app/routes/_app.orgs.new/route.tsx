import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { BuildingOffice2Icon } from "@heroicons/react/20/solid";
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
import { TextArea } from "~/components/primitives/TextArea";
import { useFeatures } from "~/hooks/useFeatures";
import { createOrganization } from "~/models/organization.server";
import { NewOrganizationPresenter } from "~/presenters/NewOrganizationPresenter.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { sendNewOrgMessage } from "~/services/slack.server";
import { organizationPath, rootPath } from "~/utils/pathBuilder";

const schema = z.object({
  orgName: z.string().min(3).max(50),
  companySize: z.string().optional(),
  whyUseUs: z.string().optional(),
});

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const presenter = new NewOrganizationPresenter();
  const { hasOrganizations } = await presenter.call({ userId: userId });

  return typedjson({
    hasOrganizations,
  });
};

export const action: ActionFunction = async ({ request }) => {
  const user = await requireUser(request);
  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    const organization = await createOrganization({
      title: submission.value.orgName,
      userId: user.id,
      companySize: submission.value.companySize ?? null,
    });

    const whyUseUs = formData.get("whyUseUs");

    if (whyUseUs) {
      await sendNewOrgMessage({
        orgName: submission.value.orgName,
        whyUseUs: whyUseUs.toString(),
        userEmail: user.email,
      });
    }

    return redirect(organizationPath(organization));
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};

export default function NewOrganizationPage() {
  const { hasOrganizations } = useTypedLoaderData<typeof loader>();
  const lastSubmission = useActionData();
  const { isManagedCloud } = useFeatures();
  const navigation = useNavigation();

  const [form, { orgName }] = useForm({
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
      <FormTitle
        LeadingIcon={<BuildingOffice2Icon className="size-6 text-fuchsia-600" />}
        title="Create an Organization"
      />
      <Form method="post" {...form.props}>
        <Fieldset>
          <InputGroup>
            <Label htmlFor={orgName.id}>Organization name</Label>
            <Input
              {...conform.input(orgName, { type: "text" })}
              placeholder="Your Organization name"
              icon={BuildingOffice2Icon}
              autoFocus
            />
            <Hint>E.g. your company name or your workspace name.</Hint>
            <FormError id={orgName.errorId}>{orgName.error}</FormError>
          </InputGroup>
          {isManagedCloud && (
            <>
              <InputGroup>
                <Label htmlFor={"companySize"}>Number of employees</Label>
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
              <InputGroup>
                <Label htmlFor={"whyUseUs"}>What problem are you trying to solve?</Label>
                <TextArea name="whyUseUs" rows={4} spellCheck={false} />
                <Hint>
                  Your answer will help us understand your use case and provide better support.
                </Hint>
              </InputGroup>
            </>
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
