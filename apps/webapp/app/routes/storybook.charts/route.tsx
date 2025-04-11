import { type ChartConfig } from "~/components/primitives/charts/Chart";
import { ChartBar } from "~/components/primitives/charts/Charts";
import { Header2 } from "~/components/primitives/Headers";

const chartData = [
  { month: "Nov_21", desktop: 186 },
  { month: "Nov_22", desktop: 305 },
  { month: "Nov_23", desktop: 237 },
  { month: "Nov_24", desktop: 73 },
  { month: "Nov_25", desktop: 209 },
  { month: "Nov_26", desktop: 214 },
];

const chartConfig = {
  desktop: {
    label: "Desktop",
    color: "#2563eb",
  },
  mobile: {
    label: "Mobile",
    color: "#60a5fa",
  },
} satisfies ChartConfig;

export default function Story() {
  return (
    <div className="grid grid-cols-3">
      <div className="flex flex-col items-start gap-y-4 p-4">
        <Header2>Bar charts</Header2>
        <ChartBar config={chartConfig} data={chartData} />
      </div>
      <div className="flex flex-col items-start gap-y-4 p-4">
        <Header2>Line charts</Header2>
        <ChartBar config={chartConfig} data={chartData} />
      </div>
      <div className="flex flex-col items-start gap-y-4 p-4">
        <Header2>Big numbers</Header2>
        <ChartBar config={chartConfig} data={chartData} />
      </div>
      <div className="flex flex-col items-start gap-y-4 p-4">
        <Header2>Stepped charts</Header2>
        <ChartBar config={chartConfig} data={chartData} />
      </div>
    </div>
  );
}
