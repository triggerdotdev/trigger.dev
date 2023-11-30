import { PricingCalculator } from "~/components/billing/PricingCalculator";
import { PricingTiers, TierEnterprise, TierFree, TierPro } from "~/components/billing/PricingTiers";
import { RunsVolumeDiscountTable } from "~/components/billing/RunsVolumeDiscountTable";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { Handle } from "~/utils/handle";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="Plans" />,
};

export default function Page() {
  return (
    <div className="flex flex-col gap-4">
      <Callout variant={"pricing"}>
        Some of your Runs are being queued because your Run concurrency is limited to 50.
      </Callout>
      <PricingTiers>
        <TierFree />
        <TierPro />
        <TierEnterprise />
      </PricingTiers>
      <div>
        <Header2 spacing>Estimate your usage</Header2>
        <div className="flex h-full w-full rounded-md border border-border p-6">
          <PricingCalculator />
          <div className="mx-6 min-h-full w-px bg-border" />
          <RunsVolumeDiscountTable />
        </div>
      </div>
    </div>
  );
}
