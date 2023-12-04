import { ChartBarIcon } from "@heroicons/react/20/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
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
import { featuresForRequest } from "~/features.server";
import { OrgBillingPlanPresenter } from "~/presenters/OrgBillingPlanPresenter";
import {
  OrganizationParamsSchema,
  organizationBillingPath,
  organizationPath,
} from "~/utils/pathBuilder";

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

export default function ChoosePlanPage() {
  const { plans, organizationSlug } = useTypedLoaderData<typeof loader>();

  return (
    <div className="mx-auto flex h-full w-full max-w-[80rem] flex-col items-center justify-center gap-12 overflow-y-auto px-12">
      <Header1>Subscribe for full access</Header1>
      <PricingTiers
        organizationSlug={organizationSlug}
        plans={plans}
        showActionText={false}
        freeButtonPath={organizationPath({ slug: organizationSlug })}
      />

      <Sheet>
        <SheetTrigger asChild>
          <Button variant="tertiary/small" LeadingIcon={ChartBarIcon} leadingIconClassName="px-0">
            Estimate usage
          </Button>
        </SheetTrigger>
        <SheetContent size="lg">
          <SheetHeader className="justify-between">
            <div className="flex items-center gap-4">
              <Header1>Estimate your usage</Header1>
            </div>
          </SheetHeader>
          <SheetBody>
            <PricingCalculator plans={plans} />
            <div className="mt-8 rounded border border-border p-6">
              <RunsVolumeDiscountTable brackets={plans.paid.runs?.pricing?.brackets ?? []} />
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
