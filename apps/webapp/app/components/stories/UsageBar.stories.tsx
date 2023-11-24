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
    <div className="m-12 flex h-screen flex-col items-center justify-center gap-8">
      <UsageBar />
    </div>
  );
}
