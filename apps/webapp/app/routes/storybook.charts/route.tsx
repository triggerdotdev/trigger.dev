import { Button } from "~/components/primitives/Buttons";
import { Card } from "~/components/primitives/charts/Card";
import { type ChartConfig } from "~/components/primitives/charts/Chart";
import {
  BigNumber,
  ChartBar,
  ChartLine,
  ChartStacked,
  ChartStepped,
} from "~/components/primitives/charts/Charts";

export default function Story() {
  return (
    <div className="grid grid-cols-2 gap-4 p-8">
      <Card>
        <Card.Header>ChartStacked</Card.Header>
        <Card.Content>
          <ChartStacked config={stackedChartConfig} data={stackedChartData} dataKey="day" />
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>ChartLine</Card.Header>
        <Card.Content>
          <ChartLine config={lineChartConfig} data={lineChartData} dataKey="day" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>ChartBar</Card.Header>
        <Card.Content>
          <ChartBar config={barChartConfig} data={barChartData} dataKey="day" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>ChartStepped</Card.Header>
        <Card.Content>
          <ChartStepped config={lineChartConfig} data={lineChartData} dataKey="day" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>
          BigNumber
          <Card.Accessory>
            <Button variant="secondary/small">Example button</Button>
          </Card.Accessory>
        </Card.Header>
        <Card.Content>
          <BigNumber value={101} suffix="USD" />
        </Card.Content>
      </Card>
    </div>
  );
}

const barChartConfig = {
  value: {
    label: "Runs",
    color: "#6366F1",
  },
} satisfies ChartConfig;

const barChartData = [
  { day: "Nov 21", value: 186 },
  { day: "Nov 22", value: 305 },
  { day: "Nov 23", value: 237 },
  { day: "Nov 24", value: 73 },
  { day: "Nov 25", value: 209 },
  { day: "Nov 26", value: 214 },
  { day: "Nov 27", value: 546 },
];

const lineChartConfig = {
  desktop: {
    label: "Desktop",
    color: "#3B82F6",
  },
  mobile: {
    label: "Mobile",
    color: "#28BF5C",
  },
} satisfies ChartConfig;

const lineChartData = [
  { day: "Nov 21", desktop: 186, mobile: 80 },
  { day: "Nov 22", desktop: 305, mobile: 200 },
  { day: "Nov 23", desktop: 237, mobile: 120 },
  { day: "Nov 24", desktop: 73, mobile: 190 },
  { day: "Nov 25", desktop: 209, mobile: 130 },
  { day: "Nov 26", desktop: 214, mobile: 140 },
  { day: "Nov 27", desktop: 546, mobile: 150 },
];

const stackedChartData = [
  { day: "Nov 21", "in-progress": 8432, canceled: 0, completed: 10456, failed: 2341 },
  { day: "Nov 22", "in-progress": 156, canceled: 4521, completed: 0, failed: 7890 },
  { day: "Nov 23", "in-progress": 9876, canceled: 120, completed: 0, failed: 5432 },
  { day: "Nov 24", "in-progress": 8765, canceled: 0, completed: 3421, failed: 6543 },
  { day: "Nov 25", "in-progress": 7123, canceled: 0, completed: 9876, failed: 2109 },
  { day: "Nov 26", "in-progress": 4567, canceled: 6789, completed: 0, failed: 8901 },
  { day: "Nov 27", "in-progress": 3210, canceled: 9012, completed: 0, failed: 6789 },
];
const stackedChartConfig = {
  "in-progress": {
    label: "In Progress",
    color: "#3B82F6",
  },
  canceled: {
    label: "Canceled",
    color: "#878C99",
  },
  completed: {
    label: "Completed",
    color: "#28BF5C",
  },
  failed: {
    label: "Failed",
    color: "#E11D48",
  },
} satisfies ChartConfig;
