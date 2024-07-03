import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { MainCenteredContainer } from "~/components/layout/AppLayout";
import { Header1 } from "~/components/primitives/Headers";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { getCurrentPlan, getPlans } from "~/services/platform.v3.server";
import { requireUserId } from "~/services/session.server";
import { OrganizationParamsSchema, organizationPath } from "~/utils/pathBuilder";
import { PricingPlans } from "../resources.orgs.$organizationSlug.select-plan";

export async function loader({ params, request }: LoaderFunctionArgs) {
  await requireUserId(request);
  const { organizationSlug } = OrganizationParamsSchema.parse(params);

  const { isManagedCloud } = featuresForRequest(request);
  if (!isManagedCloud) {
    return redirect(organizationPath({ slug: organizationSlug }));
  }

  const plans = await getPlans();
  if (!plans) {
    throw new Response(null, { status: 404, statusText: "Plans not found" });
  }

  const organization = await prisma.organization.findUnique({
    where: { slug: organizationSlug },
  });

  if (!organization) {
    throw new Response(null, { status: 404, statusText: "Organization not found" });
  }

  if (organization.v3Enabled) {
    return redirect(organizationPath({ slug: organizationSlug }));
  }

  const currentPlan = await getCurrentPlan(organization.id);

  return typedjson({ ...plans, ...currentPlan, organizationSlug });
}

export default function ChoosePlanPage() {
  const { plans, v3Subscription, organizationSlug } = useTypedLoaderData<typeof loader>();

  return (
    <MainCenteredContainer className="flex max-w-[80rem] flex-col items-center gap-8 p-3">
      <Header1 className="text-center">Subscribe for full access</Header1>
      <PricingPlans
        plans={plans}
        subscription={v3Subscription}
        organizationSlug={organizationSlug}
        hasPromotedPlan
      />
    </MainCenteredContainer>
  );
}
