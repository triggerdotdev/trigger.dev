import { PricingTiers, TierEnterprise, TierFree, TierPro } from "~/components/billing/PricingTiers";
import { BreadcrumbLink } from "~/components/navigation/Breadcrumb";
import { Callout } from "~/components/primitives/Callout";
import { Handle } from "~/utils/handle";

export const handle: Handle = {
  breadcrumb: (match) => <BreadcrumbLink to={match.pathname} title="Plans" />,
};

export default function Page() {
  return (
    <div>
      <Callout variant={"pricing"} className="mb-4">
        Some of your Runs are being queued because your Run concurrency is limited to 50.
      </Callout>
      <PricingTiers>
        <TierFree />
        <TierPro />
        <TierEnterprise />
      </PricingTiers>
    </div>
  );
}
