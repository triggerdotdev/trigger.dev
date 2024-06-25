import { ChartBarIcon } from "@heroicons/react/20/solid";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { PricingCalculator } from "~/components/billing/v2/PricingCalculator";
import { PricingTiers } from "~/components/billing/v2/PricingTiers";
import { RunsVolumeDiscountTable } from "~/components/billing/v2/RunsVolumeDiscountTable";
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
import { useOptionalProject, useProject } from "~/hooks/useProject";
import { OrgBillingPlanPresenter } from "~/presenters/OrgBillingPlanPresenter";
import { OrganizationsPresenter } from "~/presenters/OrganizationsPresenter.server";
import { requireUserId } from "~/services/session.server";
import {
  OrganizationParamsSchema,
  organizationBillingPath,
  organizationPath,
  projectPath,
} from "~/utils/pathBuilder";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
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

  const orgsPresenter = new OrganizationsPresenter();
  const { project } = await orgsPresenter.call({
    userId,
    request,
    organizationSlug,
    projectSlug: undefined,
  });

  return typedjson({ plans: result.plans, organizationSlug, projectSlug: project.slug });
}

export default function ChoosePlanPage() {
  const { plans, organizationSlug, projectSlug } = useTypedLoaderData<typeof loader>();

  return (
    <div className="mx-auto flex h-full w-full max-w-[80rem] flex-col items-center justify-center gap-12 overflow-y-auto px-12">
      <Header1>Subscribe for full access</Header1>
      <PricingTiers
        organizationSlug={organizationSlug}
        plans={plans}
        showActionText={false}
        freeButtonPath={projectPath({ slug: organizationSlug }, { slug: projectSlug })}
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
            <div className="mt-8 rounded border border-grid-bright p-6">
              <RunsVolumeDiscountTable brackets={plans.paid.runs?.pricing?.brackets ?? []} />
            </div>
          </SheetBody>
        </SheetContent>
      </Sheet>
    </div>
  );
}
