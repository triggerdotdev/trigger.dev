import { useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { useActionData } from "@remix-run/react";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { SetPlanBodySchema } from "@trigger.dev/billing";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { PricingCalculator } from "~/components/billing/PricingCalculator";
import { PricingTiers, TierEnterprise, TierFree, TierPro } from "~/components/billing/PricingTiers";
import { RunsVolumeDiscountTable } from "~/components/billing/RunsVolumeDiscountTable";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { featuresForRequest } from "~/features.server";
import { OrgBillingPlanPresenter } from "~/presenters/OrgBillingPlanPresenter";
import { Handle } from "~/utils/handle";
import { OrganizationParamsSchema, organizationBillingPath } from "~/utils/pathBuilder";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const { isManagedCloud } = featuresForRequest(request);
  if (!isManagedCloud) {
    return redirect(organizationBillingPath({ slug: organizationSlug }));
  }

  const presenter = new OrgBillingPlanPresenter();
  const plans = await presenter.call({ slug: organizationSlug });
  if (!plans) {
    throw new Response(null, { status: 404 });
  }

  return typedjson({ plans, organizationSlug });
}

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="Plans" />,
};

export default function Page() {
  const { plans, organizationSlug } = useTypedLoaderData<typeof loader>();

  return (
    <div className="flex flex-col gap-4">
      <Callout variant={"pricing"}>
        Some of your Runs are being queued because your Run concurrency is limited to 50.
      </Callout>
      <Callout variant={"pricing"}>
        You have exceeded the monthly 10,000 Runs limit. Upgrade to a paid plan before Nov 30.
      </Callout>
      <PricingTiers organizationSlug={organizationSlug} plans={plans} />
      <div>
        <Header2 spacing>Estimate your usage</Header2>
        <div className="flex h-full w-full rounded-md border border-border p-6">
          <PricingCalculator plans={plans} />
          <div className="mx-6 min-h-full w-px bg-border" />
          <RunsVolumeDiscountTable brackets={plans.paid.runs?.pricing?.brackets ?? []} />
        </div>
      </div>
    </div>
  );
}
