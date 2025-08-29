import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { AppContainer } from "~/components/layout/AppLayout";
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

  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  return typedjson({ ...plans, ...currentPlan, organizationSlug, periodEnd });
}

export default function ChoosePlanPage() {
  const { plans, v3Subscription, organizationSlug, periodEnd } =
    useTypedLoaderData<typeof loader>();

  return (
    <AppContainer className="bg-charcoal-900">
      <BackgroundWrapper>
        <div className="mx-auto flex h-full w-full max-w-[80rem] flex-col items-center justify-center gap-8 p-3">
          <Header1 className="text-center">Subscribe for full access</Header1>
          <div className="w-full rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg">
            <PricingPlans
              plans={plans}
              subscription={v3Subscription}
              organizationSlug={organizationSlug}
              hasPromotedPlan
              showGithubVerificationBadge
              periodEnd={periodEnd}
            />
          </div>
        </div>
      </BackgroundWrapper>
    </AppContainer>
  );
}
