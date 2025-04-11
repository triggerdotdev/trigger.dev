import { Card } from "~/components/primitives/charts/Card";
import { type ChartConfig } from "~/components/primitives/charts/Chart";
import { ChartBar } from "~/components/primitives/charts/Charts";
import { Header2 } from "~/components/primitives/Headers";

const barChartData = [
  { day: "Nov 21", value: 186 },
  { day: "Nov 22", value: 305 },
  { day: "Nov 23", value: 237 },
  { day: "Nov 24", value: 73 },
  { day: "Nov 25", value: 209 },
  { day: "Nov 26", value: 214 },
  { day: "Nov 27", value: 546 },
];

const chartConfig = {
  value: {
    label: "Value",
    color: "#6366F1",
  },
} satisfies ChartConfig;

export default function Story() {
  return (
    <div className="grid grid-cols-3 gap-4 p-8">
      <Card>
        <Card.Header>Bar chart</Card.Header>
        <Card.Content>
          <ChartBar config={chartConfig} data={barChartData} dataKey="value" />
        </Card.Content>
      </Card>

      <Card>
        <Card.Header>Line chart</Card.Header>
        <Card.Content>
          <ChartBar config={chartConfig} data={barChartData} dataKey="value" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>Big number</Card.Header>
        <Card.Content>
          <ChartBar config={chartConfig} data={barChartData} dataKey="value" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>Stepped chart</Card.Header>
        <Card.Content>
          <ChartBar config={chartConfig} data={barChartData} dataKey="value" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>Stacked chart</Card.Header>
        <Card.Content>
          <ChartBar config={chartConfig} data={barChartData} dataKey="value" />
        </Card.Content>
      </Card>
    </div>
  );
}
