import type { Meta, StoryObj } from "@storybook/react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  TooltipProps,
  XAxis,
  YAxis,
} from "recharts";

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

const data = [
  {
    name: "Nov 23",
    "Concurrent Runs": 2,
  },
  {
    name: "Dec 23",
    "Concurrent Runs": 4,
  },
  {
    name: "Jan 24",
    "Concurrent Runs": 3,
  },
  {
    name: "Feb 24",
    "Concurrent Runs": 5,
  },
  {
    name: "Mar 24",
    "Concurrent Runs": 25,
  },
  {
    name: "Apr 24",
    "Concurrent Runs": 10,
  },
  {
    name: "May 24",
    "Concurrent Runs": null,
  },
  {
    name: "Jun 24",
    "Concurrent Runs": null,
  },
  {
    name: "Jul 24",
    "Concurrent Runs": null,
  },
  {
    name: "Aug 24",
    "Concurrent Runs": null,
  },
  {
    name: "Sep 24",
    "Concurrent Runs": null,
  },
  {
    name: "Oct 24",
    "Concurrent Runs": null,
  },
];

function UsageCharts() {
  return (
    <div className="mx-4 flex h-screen items-center justify-center">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          width={500}
          height={300}
          data={data}
          margin={{
            top: 20,
            right: 50,
            left: 20,
            bottom: 20,
          }}
        >
          <XAxis dataKey="name" />
          <YAxis />
          <Tooltip />
          <ReferenceLine
            y={25}
            label="Tier limit"
            stroke="#F43F5E"
            strokeDasharray={5}
            isFront
            ifOverflow="extendDomain"
          />
          <Line type="stepAfter" dataKey="Concurrent Runs" stroke="#22C55E" strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function RunQueueChart() {
  return <div className="mx-4 flex h-screen items-center justify-center">Run Queue chart</div>;
}

const CustomTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
  if (active && payload) {
    return (
      <div className="flex items-center gap-2 rounded border border-border bg-slate-900 px-4 py-2 text-sm text-dimmed">
        <p className="text-white">{label}:</p>
        <p className="text-white">{payload[0].value}</p>
      </div>
    );
  }

  return null;
};
