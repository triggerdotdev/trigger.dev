import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { BillingService } from "~/services/billing.v3.server";
import { requireUserId } from "~/services/session.server";
import {
  OrganizationParamsSchema,
  organizationPath,
  v3StripePortalPath,
} from "~/utils/pathBuilder";
import { PricingPlans } from "../resources.orgs.$organizationSlug.select-plan";

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
    <PageContainer>
      <NavBar>
        <PageTitle title="Billing" />
        <PageAccessories>
          {v3Subscription?.isPaying && (
            <>
              <LinkButton
                to={v3StripePortalPath({ slug: organizationSlug })}
                variant="tertiary/small"
              >
                Invoices
              </LinkButton>
              <LinkButton
                to={v3StripePortalPath({ slug: organizationSlug })}
                variant="tertiary/small"
              >
                Manage card details
              </LinkButton>
            </>
          )}
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={false}>
        <PricingPlans
          plans={plans}
          subscription={v3Subscription}
          organizationSlug={organizationSlug}
        />
      </PageBody>
    </PageContainer>
  );
}
