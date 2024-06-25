import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { PricingPlans } from "~/components/billing/v3/PricingPlans";
import { Header1 } from "~/components/primitives/Headers";
import { featuresForRequest } from "~/features.server";
import { BillingService } from "~/services/billing.v3.server";
import { requireUserId } from "~/services/session.server";
import { OrganizationParamsSchema, organizationPath } from "~/utils/pathBuilder";

export async function loader({ params, request }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const { isManagedCloud } = featuresForRequest(request);
  if (!isManagedCloud) {
    return redirect(organizationPath({ slug: organizationSlug }));
  }

  const billingPresenter = new BillingService(isManagedCloud);
  const result = await billingPresenter.getPlans();

  if (!result) {
    throw new Response(null, { status: 404, statusText: "Plans not found" });
  }

  return typedjson(result);
}

export default function ChoosePlanPage() {
  const { plans } = useTypedLoaderData<typeof loader>();

  return (
    <div className="mx-auto flex h-full w-full max-w-[80rem] flex-col items-center justify-center gap-12 overflow-y-auto px-12">
      <Header1>Subscribe for full access</Header1>
      <PricingPlans
        plans={plans}
        // organizationSlug={organizationSlug}
        // plans={plans}
        // showActionText={false}
        // freeButtonPath={projectPath({ slug: organizationSlug }, { slug: projectSlug })}
      />
    </div>
  );
}
