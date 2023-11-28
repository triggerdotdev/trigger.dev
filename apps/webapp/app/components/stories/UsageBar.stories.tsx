import type { Meta, StoryObj } from "@storybook/react";
import { UsageBar } from "../billing/UsageBar";
import { Paragraph } from "../primitives/Paragraph";

const meta: Meta<typeof UsageProgressBar> = {
  title: "Billing/UsageBar",
  component: UsageProgressBar,
};

export default meta;

type Story = StoryObj<typeof UsageProgressBar>;

export const JobsUsageBar: Story = {
  render: () => <UsageProgressBar />,
};

function UsageProgressBar() {
  return (
    <div className="flex flex-col justify-center gap-4 p-12">
      <UsageBarWrapper title="Usage within the free tier limit">
        <UsageBar numberOfCurrentRuns={30000} tierRunLimit={50000} projectedRuns={120000} />
      </UsageBarWrapper>
      <UsageBarWrapper title="Usage over the free tier limit">
        <UsageBar numberOfCurrentRuns={90000} tierRunLimit={50000} projectedRuns={120000} />
      </UsageBarWrapper>
      <UsageBarWrapper title="Billing limit set">
        <UsageBar
          numberOfCurrentRuns={35674}
          tierRunLimit={50000}
          projectedRuns={120000}
          billingLimit={180000}
        />
      </UsageBarWrapper>
      <UsageBarWrapper title="Paid subscriber under the free included Runs">
        <UsageBar
          numberOfCurrentRuns={10000}
          tierRunLimit={50000}
          billingLimit={180000}
          projectedRuns={120000}
          subscribedToPaidTier
        />
      </UsageBarWrapper>
      <UsageBarWrapper title="Paid subscriber over the free included Runs">
        <UsageBar
          numberOfCurrentRuns={90000}
          tierRunLimit={50000}
          billingLimit={180000}
          projectedRuns={120000}
          subscribedToPaidTier
        />
      </UsageBarWrapper>
      <UsageBarWrapper title="Brand new user usage">
        <UsageBar numberOfCurrentRuns={0} tierRunLimit={50000} projectedRuns={0} />
      </UsageBarWrapper>
      <UsageBarWrapper title="Overlapping UI example">
        <UsageBar
          numberOfCurrentRuns={95000}
          tierRunLimit={50000}
          billingLimit={55000}
          projectedRuns={93132}
          subscribedToPaidTier
        />
      </UsageBarWrapper>
    </div>
  );
}

function UsageBarWrapper({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border p-6">
      <Paragraph>{title}</Paragraph>
      {children}
    </div>
  );
}
