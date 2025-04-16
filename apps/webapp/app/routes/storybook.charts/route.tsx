import { Button } from "~/components/primitives/Buttons";
import { Card } from "~/components/primitives/charts/Card";
import { type ChartConfig } from "~/components/primitives/charts/Chart";
import { BigNumber, ChartBar, ChartLine } from "~/components/primitives/charts/Charts";

export default function Story() {
  return (
    <div className="grid grid-cols-2 gap-4 p-3">
      <Card>
        <Card.Header>Bar Chart – stacked</Card.Header>
        <Card.Content>
          <ChartBar config={barChartConfig} data={barChartData} dataKey="day" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>Bar Chart – big dataset</Card.Header>
        <Card.Content>
          <ChartBar config={barChartBigDatasetConfig} data={barChartBigDatasetData} dataKey="day" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>Line Chart – stepped</Card.Header>
        <Card.Content>
          <ChartLine config={lineChartConfig} data={lineChartData} dataKey="day" />
        </Card.Content>
      </Card>
      <Card>
        <Card.Header>
          Big Number
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

// Mock chart data

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

const barChartConfig = {
  completed: {
    label: "Completed",
    color: "#28BF5C",
  },
  "in-progress": {
    label: "In Progress",
    color: "#3B82F6",
  },
  canceled: {
    label: "Canceled",
    color: "#878C99",
  },
  failed: {
    label: "Failed",
    color: "#E11D48",
  },
} satisfies ChartConfig;

function generateRandomStackedData(numDays: number) {
  const data = [];
  const startDate = new Date(2023, 10, 21);

  for (let i = 0; i < numDays; i++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(startDate.getDate() + i);
    const day = currentDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    // Generate random values
    const completed = Math.random() < 0.5 ? 0 : Math.floor(Math.random() * 10000) + 500;
    const inProgress = Math.floor(Math.random() * 8000) + 1000;
    const canceled = Math.random() < 0.5 ? 0 : Math.floor(Math.random() * 9000) + 100;
    const failed = Math.floor(Math.random() * 6000) + 2000;

    data.push({
      day,
      completed,
      "in-progress": inProgress,
      canceled,
      failed,
    });
  }

  return data;
}

const barChartData = generateRandomStackedData(168);

const taskVerbs = [
  "sync",
  "process",
  "upload",
  "extract",
  "compress",
  "schedule",
  "convert",
  "analyze",
  "backup",
  "validate",
  "transform",
  "optimize",
];
const taskNouns = [
  "data",
  "video",
  "audio",
  "image",
  "file",
  "document",
  "pdf",
  "media",
  "content",
  "backup",
  "report",
  "metadata",
];

function generateRandomTaskName() {
  const verb = taskVerbs[Math.floor(Math.random() * taskVerbs.length)];
  const noun = taskNouns[Math.floor(Math.random() * taskNouns.length)];
  return `${verb}-${noun}`;
}

function generateRandomId() {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

const tailwindColors = {
  red: "#EF4444",
  orange: "#F97316",
  amber: "#F59E0B",
  yellow: "#EAB308",
  lime: "#84CC16",
  green: "#22C55E",
  emerald: "#10B981",
  teal: "#14B8A6",
  cyan: "#06B6D4",
  sky: "#0EA5E9",
  blue: "#3B82F6",
  indigo: "#6366F1",
  violet: "#8B5CF6",
  purple: "#A855F7",
  fuchsia: "#D946EF",
  pink: "#EC4899",
  rose: "#F43F5E",
};

function generateTaskConfig(numTasks: number) {
  const colors = Object.values(tailwindColors);
  return Array.from({ length: numTasks }, () => {
    const taskName = generateRandomTaskName();
    const taskId = generateRandomId();
    return {
      [taskName]: {
        label: (
          <div className="flex items-center gap-2">
            <span>{taskName}</span>
            <span className="text-text-dimmed/50">{taskId}</span>
          </div>
        ),
        color: colors[Math.floor(Math.random() * colors.length)],
      },
    };
  }).reduce((acc, curr) => ({ ...acc, ...curr }), {}) satisfies ChartConfig;
}

const barChartBigDatasetConfig = generateTaskConfig(8);

function generateRandomBigDatasetData(numDays: number) {
  const data = [];
  const startDate = new Date(2023, 10, 21);
  const taskNames = Object.keys(barChartBigDatasetConfig);

  for (let i = 0; i < numDays; i++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(startDate.getDate() + i);
    const day = currentDate.toLocaleDateString("en-US", { month: "short", day: "numeric" });

    const dataPoint: Record<string, string | number> = { day };
    taskNames.forEach((taskName) => {
      dataPoint[taskName] = Math.random() < 0.5 ? 0 : Math.floor(Math.random() * 10000) + 500;
    });

    data.push(dataPoint);
  }

  return data;
}

const barChartBigDatasetData = generateRandomBigDatasetData(70);
