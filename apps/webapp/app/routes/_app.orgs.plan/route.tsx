import { ChartBarIcon } from "@heroicons/react/20/solid";
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

export default function ChoosePlanPage() {
  return (
    <div className="mx-auto flex h-full w-full max-w-[80rem] flex-col items-center justify-center gap-12 overflow-y-auto px-12">
      <Header1>Subscribe for full access</Header1>
      <PricingTiers>
        <TierFree />
        <TierPro />
        <TierEnterprise />
      </PricingTiers>

      <Sheet>
        <SheetTrigger asChild>
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
