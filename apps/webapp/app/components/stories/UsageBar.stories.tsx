import type { Meta, StoryObj } from "@storybook/react";
import { UsageBar } from "../billing/UsageBar";

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
    <div className="flex h-screen flex-col items-center justify-center p-12">
      <UsageBar
        numberOfCurrentRuns={90000}
        billingLimit={180000}
        tierRunLimit={50000}
        projectedRuns={120000}
      />
      <UsageBar
        numberOfCurrentRuns={30000}
        billingLimit={180000}
        tierRunLimit={50000}
        projectedRuns={120000}
      />
      <UsageBar
        numberOfCurrentRuns={90000}
        billingLimit={180000}
        tierRunLimit={50000}
        projectedRuns={120000}
      />
    </div>
  );
}
