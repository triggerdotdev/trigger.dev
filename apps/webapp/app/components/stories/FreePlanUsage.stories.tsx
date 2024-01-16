import type { Meta, StoryObj } from "@storybook/react";
import { FreePlanUsage } from "../billing/FreePlanUsage";
import { organizationBillingPath } from "~/utils/pathBuilder";
import { MatchedOrganization } from "~/hooks/useOrganizations";

const meta: Meta<typeof FreePlanUsageBar> = {
  title: "Billing/FreePlanUsage",
  component: FreePlanUsageBar,
};

export default meta;

type Story = StoryObj<typeof FreePlanUsageBar>;

const mockOrganization: MatchedOrganization = {
  id: "mockID",
  title: "mockTitle",
  slug: "mockSlug",
  projects: [
    { id: "mockId1", slug: "mockSlug1", name: "mockName1", jobCount: 1 },
    { id: "mockId2", slug: "mockSlug2", name: "mockName2", jobCount: 2 },
  ],
  hasUnconfiguredIntegrations: false,
  memberCount: 1,
  runsEnabled: true,
};

export const ProgressBar: Story = {
  args: {
    organization: mockOrganization,
  },
  render: (args) => <FreePlanUsageBar {...args} />,
};

type FreePlanUsageBarProps = {
  organization: MatchedOrganization;
};

function FreePlanUsageBar({ organization }: FreePlanUsageBarProps) {
  return (
    <div className="flex h-screen flex-col items-center justify-center p-12">
      <div className="w-fit">
        <FreePlanUsage to={organizationBillingPath(organization)} percentage={0.75} />
      </div>
    </div>
  );
}
