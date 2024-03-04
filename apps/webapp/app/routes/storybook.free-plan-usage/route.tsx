import { FreePlanUsage } from "~/components/billing/FreePlanUsage";
import { MatchedOrganization } from "~/hooks/useOrganizations";
import { organizationBillingPath } from "~/utils/pathBuilder";

const mockOrganization: MatchedOrganization = {
  id: "mockID",
  title: "mockTitle",
  slug: "mockSlug",
  projects: [
    { id: "mockId1", slug: "mockSlug1", name: "mockName1", jobCount: 1 },
    { id: "mockId2", slug: "mockSlug2", name: "mockName2", jobCount: 2 },
  ],
  hasUnconfiguredIntegrations: false,
  runsEnabled: true,
};

type FreePlanUsageBarProps = {
  organization: MatchedOrganization;
};

export default function Story({ organization = mockOrganization }: FreePlanUsageBarProps) {
  return (
    <div className="flex h-screen flex-col items-center justify-center p-12">
      <div className="w-fit">
        <FreePlanUsage to={organizationBillingPath(organization)} percentage={0.75} />
      </div>
    </div>
  );
}
