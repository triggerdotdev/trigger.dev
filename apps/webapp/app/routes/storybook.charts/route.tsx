import { Button } from "~/components/primitives/Buttons";
import { Card } from "~/components/primitives/charts/Card";
import { type ChartConfig } from "~/components/primitives/charts/Chart";
import { BigNumber, ChartBar, ChartLine } from "~/components/primitives/charts/Charts";

export default function Story() {
  return (
    <div className="grid grid-cols-3 gap-4 p-8">
      <Card>
        <Card.Header>Bar chart</Card.Header>
        <Card.Content>
          <ChartBar config={barChartConfig} data={barChartData} dataKey="value" />
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>Line chart</Card.Header>
        <Card.Content>
          <ChartLine config={lineChartConfig} data={lineChartData} dataKey="value" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>
          Big number
          <Card.Accessory>
            <Button variant="secondary/small">Example button</Button>
          </Card.Accessory>
        </Card.Header>
        <Card.Content>
          <BigNumber value={101} suffix="USD" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>Stepped chart</Card.Header>
        <Card.Content>
          <ChartBar config={barChartConfig} data={barChartData} dataKey="value" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>Stacked chart</Card.Header>
        <Card.Content>
          <ChartBar config={barChartConfig} data={barChartData} dataKey="value" />
        </Card.Content>
      </Card>
    </div>
  );
}

const barChartConfig = {
  value: {
    label: "Value",
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
