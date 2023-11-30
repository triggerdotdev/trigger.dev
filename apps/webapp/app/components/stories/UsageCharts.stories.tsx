import type { Meta, StoryObj } from "@storybook/react";
import { TooltipProps } from "recharts";
import { ConcurrentRunsChart } from "../billing/ConcurrentRunsChart";

const meta: Meta<typeof UsageCharts> = {
  title: "Billing/UsageCharts",
  component: UsageCharts,
};

export default meta;

type Story = StoryObj<typeof UsageCharts>;

export const ConcurrentRuns: Story = {
  render: () => <UsageCharts />,
};

export const RunQueue: Story = {
  render: () => <RunQueueChart />,
};

function UsageCharts() {
  return (
    <div className="mx-4 flex h-screen items-center justify-center">
      <ConcurrentRunsChart concurrentRunsLimit={25} />
    </div>
  );
}

function RunQueueChart() {
  return <div className="mx-4 flex h-screen items-center justify-center">Run Queue chart</div>;
}
