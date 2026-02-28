import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { BuildingOffice2Icon, GlobeAltIcon } from "@heroicons/react/20/solid";
import { RadioGroup } from "@radix-ui/react-radio-group";
import { json, redirect, type ActionFunction, type LoaderFunctionArgs } from "@remix-run/node";
import { Form, useActionData, useNavigation } from "@remix-run/react";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
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
import { useFaviconUrl } from "~/hooks/useFaviconUrl";
import { useFeatures } from "~/hooks/useFeatures";
import { createOrganization } from "~/models/organization.server";
import { NewOrganizationPresenter } from "~/presenters/NewOrganizationPresenter.server";
import { requireUser, requireUserId } from "~/services/session.server";
import { extractDomain, faviconUrl } from "~/utils/favicon";
import { organizationPath, rootPath } from "~/utils/pathBuilder";

const schema = z.object({
  orgName: z.string().min(3).max(50),
  companySize: z.string().optional(),
  companyUrl: z.string().optional(),
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
    const companySize = submission.value.companySize ?? null;

    const onboardingData: Record<string, string> = {};
    if (submission.value.companyUrl) {
      onboardingData.companyUrl = submission.value.companyUrl;
    }
    if (submission.value.companySize) {
      onboardingData.companySize = submission.value.companySize;
    }

    let avatar: { type: "image"; url: string } | undefined;
    if (submission.value.companyUrl) {
      const domain = extractDomain(submission.value.companyUrl);
      if (domain) {
        avatar = { type: "image", url: faviconUrl(domain) };
      }
    }

    const organization = await createOrganization({
      title: submission.value.orgName,
      userId: user.id,
      companySize,
      onboardingData: Object.keys(onboardingData).length > 0 ? onboardingData : undefined,
      avatar,
    });

    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const configurationId = url.searchParams.get("configurationId");
    const integration = url.searchParams.get("integration");
    const next = url.searchParams.get("next");

    if (code && configurationId && integration === "vercel") {
      const params = new URLSearchParams({
        code,
        configurationId,
        integration,
      });
      if (next) {
        params.set("next", next);
      }
      const redirectUrl = `${organizationPath(organization)}/projects/new?${params.toString()}`;
      return redirect(redirectUrl);
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
  const [companyUrl, setCompanyUrl] = useState("");
  const faviconUrl = useFaviconUrl(companyUrl);
  const [faviconError, setFaviconError] = useState(false);

  const [form, { orgName }] = useForm({
    id: "create-organization",
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema });
    },
    shouldRevalidate: "onSubmit",
    shouldValidate: "onSubmit",
  });

  const isLoading = navigation.state === "submitting" || navigation.state === "loading";

  const urlIcon =
    faviconUrl && !faviconError ? (
      <img
        src={faviconUrl}
        alt=""
        width={16}
        height={16}
        className="ml-0.5 shrink-0 rounded-sm"
        onError={() => setFaviconError(true)}
        onLoad={() => setFaviconError(false)}
      />
    ) : (
      GlobeAltIcon
    );

  return (
    <AppContainer className="bg-charcoal-900">
      <BackgroundWrapper>
        <MainCenteredContainer className="max-w-[26rem] rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
          <FormTitle
            LeadingIcon={<BuildingOffice2Icon className="size-6 text-fuchsia-600" />}
            title="Create an Organization"
          />
          <Form method="post" {...form.props}>
            <Fieldset>
              <InputGroup>
                <Label htmlFor={orgName.id}>Organization name *</Label>
                <Input
                  {...conform.input(orgName, { type: "text" })}
                  placeholder="Your Organization name"
                  icon={BuildingOffice2Icon}
                  autoFocus
                />
                <Hint>Normally your company name.</Hint>
                <FormError id={orgName.errorId}>{orgName.error}</FormError>
              </InputGroup>
              {isManagedCloud && (
                <>
                  <InputGroup>
                    <Label htmlFor="companyUrl">URL</Label>
                    <Input
                      id="companyUrl"
                      name="companyUrl"
                      type="url"
                      placeholder="Your Organization URL"
                      icon={urlIcon}
                      value={companyUrl}
                      onChange={(e) => {
                        setCompanyUrl(e.target.value);
                        setFaviconError(false);
                      }}
                    />
                    <Hint>Add your company URL and we'll use it as your organization's logo.</Hint>
                  </InputGroup>
                  <InputGroup>
                    <Label htmlFor="companySize">Number of employees</Label>
                    <RadioGroup
                      name="companySize"
                      className="flex items-center justify-between gap-2"
                    >
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
                    <LinkButton to={rootPath()} variant={"secondary/small"}>
                      Cancel
                    </LinkButton>
                  ) : null
                }
              />
            </Fieldset>
          </Form>
        </MainCenteredContainer>
      </BackgroundWrapper>
    </AppContainer>
  );
}
