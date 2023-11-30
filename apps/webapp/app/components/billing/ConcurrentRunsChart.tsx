import {
  Label,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Header3 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";

const tooltipStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  borderRadius: "0.25rem",
  border: "1px solid #1A2434",
  backgroundColor: "#0B1018",
  padding: "0.3rem 0.5rem",
  fontSize: "0.75rem",
  color: "#E2E8F0",
};

export function ConcurrentRunsChart({
  concurrentRunsLimit: planLimit,
}: {
  concurrentRunsLimit: number;
}) {
  return (
    <>
      <Header3 className="mb-4">Monthly concurrent Runs</Header3>
      <ResponsiveContainer width="100%" height="100%" className="min-h-[20rem]">
        <LineChart
          data={ConcurrentRunsData}
          margin={{
            top: 0,
            right: 0,
            left: 0,
            bottom: 0,
          }}
          className="-ml-8"
        >
          <XAxis stroke="#94A3B8" fontSize={12} tickLine={false} axisLine={false} dataKey="name" />
          <YAxis stroke="#94A3B8" fontSize={12} tickLine={false} axisLine={false} />
          <Tooltip cursor={{ fill: "rgba(255,255,255,0.05)" }} contentStyle={tooltipStyle} />
          <ReferenceLine
            y={planLimit}
            label={<ReferenceLineLabel />}
            stroke="#1A2434"
            color="#fff"
            strokeDasharray={5}
            ifOverflow="extendDomain"
            className="text-xs"
          />
          <Line type="stepAfter" dataKey="Concurrent Runs" stroke="#16A34A" strokeWidth={2} />
        </LineChart>
      </ResponsiveContainer>
    </>
  );
}

function ReferenceLineLabel() {
  return (
    <text x={500} y={"31"} fill={"#94A3B8"} textAnchor="middle">
      <tspan x={"8em"} dy={"0.3em"}>
        Plan limit
      </tspan>
    </text>
  );
}

export const ConcurrentRunsData = [
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
    "Concurrent Runs": 2,
  },
  {
    name: "May 24",
    "Concurrent Runs": 10,
  },
  {
    name: "Jun 24",
    "Concurrent Runs": 8,
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
