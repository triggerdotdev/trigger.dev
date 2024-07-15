import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { PricingCalculator } from "~/components/billing/v2/PricingCalculator";
import { PricingTiers } from "~/components/billing/v2/PricingTiers";
import { RunsVolumeDiscountTable } from "~/components/billing/v2/RunsVolumeDiscountTable";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { featuresForRequest } from "~/features.server";
import { OrgBillingPlanPresenter } from "~/presenters/OrgBillingPlanPresenter";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { OrganizationParamsSchema, organizationBillingPath } from "~/utils/pathBuilder";
import { useCurrentPlan } from "../_app.orgs.$organizationSlug/route";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const { isManagedCloud } = featuresForRequest(request);
  if (!isManagedCloud) {
    return redirect(organizationBillingPath({ slug: organizationSlug }));
  }

  const presenter = new OrgBillingPlanPresenter();
  const result = await presenter.call({ slug: organizationSlug, isManagedCloud });
  if (!result) {
    throw new Response(null, { status: 404 });
  }

  return typedjson({
    plans: result.plans,
    maxConcurrency: result.maxConcurrency,
    organizationSlug,
  });
}

export default function Page() {
  const { plans, maxConcurrency, organizationSlug } = useTypedLoaderData<typeof loader>();
  const currentPlan = useCurrentPlan();

  const hitConcurrencyLimit =
    currentPlan?.subscription?.limits.concurrentRuns && maxConcurrency
      ? maxConcurrency >= currentPlan.subscription!.limits.concurrentRuns!
      : false;

  const hitRunLimit = currentPlan?.usage?.runCountCap
    ? currentPlan.usage.currentRunCount > currentPlan.usage.runCountCap
    : false;

  return (
    <div className="flex flex-col gap-4 px-4">
      {hitConcurrencyLimit && (
        <Callout variant={"pricing"}>
          Some of your runs are being queued because your run concurrency is limited to{" "}
          {currentPlan?.subscription?.limits.concurrentRuns}.
        </Callout>
      )}
      {hitRunLimit && (
        <Callout variant={"error"}>
          {`You have exceeded the monthly
          ${formatNumberCompact(currentPlan!.subscription!.limits.runs!)} runs limit. Upgrade so you
          can continue to perform runs.`}
        </Callout>
      )}
      <PricingTiers organizationSlug={organizationSlug} plans={plans} />
      <div>
        <Header2 spacing>Estimate your usage</Header2>
        <div className="flex h-full w-full rounded-md border border-grid-bright p-6">
          <PricingCalculator plans={plans} />
          <div className="mx-6 min-h-full w-px bg-grid-bright" />
          <RunsVolumeDiscountTable brackets={plans.paid.runs?.pricing?.brackets ?? []} />
        </div>
      </div>
    </div>
  );
}
