import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { ChartBarIcon } from "@heroicons/react/20/solid";
import type { ActionFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PricingCalculator } from "~/components/billing/PricingCalculator";
import { PricingTiers, TierEnterprise, TierFree, TierPro } from "~/components/billing/PricingTiers";
import { RunsVolumeDiscountTable } from "~/components/billing/RunsVolumeDiscountTable";
import { Button } from "~/components/primitives/Buttons";
import { Header1 } from "~/components/primitives/Headers";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTrigger,
} from "~/components/primitives/Sheet";
import { createOrganization } from "~/models/organization.server";
import { NewOrganizationPresenter } from "~/presenters/NewOrganizationPresenter.server";
import { commitCurrentProjectSession, setCurrentProjectId } from "~/services/currentProject.server";
import { requireUserId } from "~/services/session.server";
import { projectPath } from "~/utils/pathBuilder";

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

export default function ChoosePlanPage() {
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
    <div className="mx-auto flex h-full w-full max-w-[80rem] flex-col items-center justify-center gap-12 overflow-y-auto px-12">
      <Header1>Subscribe for full access</Header1>
      <PricingTiers>
        <TierFree />
        <TierPro />
        <TierEnterprise />
      </PricingTiers>

      <Sheet>
        <SheetTrigger>
          <Button variant="tertiary/small" LeadingIcon={ChartBarIcon} leadingIconClassName="px-0">
            Estimate usage
          </Button>
        </SheetTrigger>
        <SheetContent size="content">
          <SheetHeader className="justify-between">
            <div className="flex items-center gap-4">
              <Header1>Estimate your usage</Header1>
            </div>
          </SheetHeader>
          <SheetBody>
            <PricingCalculator />
            <div className="mt-8 rounded border border-border p-6">
              <RunsVolumeDiscountTable />
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
