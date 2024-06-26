import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";

import { Header1 } from "~/components/primitives/Headers";
import { featuresForRequest } from "~/features.server";
import { BillingService } from "~/services/billing.v3.server";
import { requireUserId } from "~/services/session.server";
import { OrganizationParamsSchema, organizationPath } from "~/utils/pathBuilder";
import { PricingPlans } from "../resources.orgs.$organizationSlug.select-plan";
import { prisma } from "~/db.server";

export async function loader({ params, request }: LoaderFunctionArgs) {
  await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const { isManagedCloud } = featuresForRequest(request);
  if (!isManagedCloud) {
    return redirect(organizationPath({ slug: organizationSlug }));
  }

  const billingPresenter = new BillingService(isManagedCloud);
  const plans = await billingPresenter.getPlans();
  if (!plans) {
    throw new Response(null, { status: 404, statusText: "Plans not found" });
  }

  const organization = await prisma.organization.findUnique({
    where: { slug: organizationSlug },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  const currentPlan = await billingPresenter.currentPlan(organization.id);

  return typedjson({ ...plans, ...currentPlan, organizationSlug });
}

export default function ChoosePlanPage() {
  const { plans, v3Subscription, organizationSlug } = useTypedLoaderData<typeof loader>();

  return (
    <div className="mx-auto flex h-full w-full max-w-[80rem] flex-col items-center justify-center gap-12 overflow-y-auto px-12">
      <Header1>Subscribe for full access</Header1>
      <PricingPlans
        plans={plans}
        subscription={v3Subscription}
        organizationSlug={organizationSlug}
      />
    </div>
  );
}
