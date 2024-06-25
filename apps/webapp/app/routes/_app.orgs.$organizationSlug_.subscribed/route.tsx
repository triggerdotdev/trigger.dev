import { CheckBadgeIcon } from "@heroicons/react/24/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { RunsVolumeDiscountTable } from "~/components/billing/RunsVolumeDiscountTable";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Paragraph } from "~/components/primitives/Paragraph";
import { featuresForRequest } from "~/features.server";
import { useNewCustomerSubscribed } from "~/hooks/useNewCustomerSubscribed";
import { OrganizationsPresenter } from "~/presenters/OrganizationsPresenter.server";
import { BillingService } from "~/services/billing.v2.server";
import { requireUserId } from "~/services/session.server";
import { Handle } from "~/utils/handle";
import { OrganizationParamsSchema } from "~/utils/pathBuilder";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);

  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const orgsPresenter = new OrganizationsPresenter();
  const { organization } = await orgsPresenter.call({
    userId,
    request,
    organizationSlug,
    projectSlug: undefined,
  });

  const { isManagedCloud } = featuresForRequest(request);
  const billingPresenter = new BillingService(isManagedCloud);
  const currentPlan = await billingPresenter.currentPlan(organization.id);
  const plans = await billingPresenter.getPlans();

  return typedjson({
    currentPlan,
    plans,
  });
};

export const handle: Handle = {
  scripts: () => [
    {
      src: "https://cdn.jsdelivr.net/npm/canvas-confetti@1.5.1/dist/confetti.browser.min.js",
      crossOrigin: "anonymous",
    },
  ],
};

export default function Subscribed() {
  const { currentPlan, plans } = useTypedLoaderData<typeof loader>();
  useNewCustomerSubscribed();

  return (
    <MainCenteredContainer className="max-w-[22rem]">
      <FormTitle
        LeadingIcon={<CheckBadgeIcon className="h-7 w-7 text-green-600" />}
        title="You're subscribed!"
        className="mb-0"
      />
      <ul>
        <PlanItem item="Your plan" value={currentPlan?.subscription?.plan.title ?? "–"} />
        <PlanItem
          item="Concurrent runs/mo"
          value={`${currentPlan?.subscription?.plan.concurrentRuns.pricing?.upto}`}
        />
        <PlanItem item="Runs/mo" value="Volume discounted" />
      </ul>

      <RunsVolumeDiscountTable
        hideHeader
        className="mb-4 border-b border-grid-bright pb-2 pl-4"
        brackets={plans?.paid.runs?.pricing?.brackets ?? []}
      />
      <FormButtons
        confirmButton={
          <LinkButton to={"/"} variant={"primary/small"} TrailingIcon={"arrow-right"}>
            Continue
          </LinkButton>
        }
      />
    </MainCenteredContainer>
  );
}

function PlanItem({ item, value }: { item: string; value: string }) {
  return (
    <li className="flex items-center justify-between border-b border-grid-bright py-2">
      <Paragraph>{item}</Paragraph>
      <Paragraph variant="base/bright" className="font-medium">
        {value}
      </Paragraph>
    </li>
  );
}
