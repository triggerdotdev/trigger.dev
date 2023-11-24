import { cn } from "~/utils/cn";
import { Paragraph } from "../primitives/Paragraph";

//data
const numberOfCurrentRuns = 120_000;
const tierRunLimit = 100_000;
const billingLimit = 100 / 0.00125; // $100 spend limit divided by the cost per run (80,000 runs)
const projectedRuns = 10_000;

//create a maximum range for the progress bar
const getLargestNumber = Math.max(numberOfCurrentRuns, tierRunLimit, billingLimit, projectedRuns);
const maxRange = Math.round(getLargestNumber * 1.15);
console.log("Max range:", maxRange);

//convert numberOfCurrentRuns runs into a percentage and calculate the exceeded amount
let progressAsPercent = (numberOfCurrentRuns / tierRunLimit) * 100; // get current runs as a percentage
let currentProgress = Math.max(tierRunLimit, progressAsPercent); // set the current progress to the larger of the two
currentProgress = Math.min(progressAsPercent, 100); // set the current progress to a maximum of 100%
const exceededProgress = (numberOfCurrentRuns / tierRunLimit) * 100; // get the exceeded number of runs as a percentage

//Todo this code is correct but the calculations above mean the exceeded progress bar can still push over 100%
//find the overall progress as a percentage of the maxRange
const exceededProgressAsRuns = Math.max(0, numberOfCurrentRuns - tierRunLimit); // get the exceeded number of runs
let overallProgress = Math.round(((numberOfCurrentRuns + exceededProgressAsRuns) / maxRange) * 100); // get the overall progress as a percentage of the maxRange
overallProgress = Math.min(progressAsPercent, 100); // set the overall progress to a maximum of 100%
console.log("number of current runs:", numberOfCurrentRuns);
console.log("Exceeded Progress as Run count:", exceededProgressAsRuns);
console.log("Overall progress:", overallProgress);

//convert the freeRunLimit into a percentage
const freeRunLimit = Math.round((tierRunLimit / maxRange) * 100);

export function UsageBar() {
  return (
    <div className="track relative w-full rounded-sm bg-slate-800">
      <div style={{ width: `${70}%` }} className="usage absolute h-3 rounded-l-sm bg-green-900/50">
        <Legend text="Billing limit:" value={numberOfCurrentRuns} position="bottomRow2" />
      </div>
      <div style={{ width: `${60}%` }} className="usage absolute h-3 rounded-l-sm bg-green-900">
        <Legend text="Free tier limit:" value={numberOfCurrentRuns} position="bottomRow1" />
      </div>
      <div style={{ width: `${80}%` }} className="usage absolute h-3 rounded-l-sm">
        <Legend text="Projected:" value={numberOfCurrentRuns} position="topRow2" />
      </div>
      <div style={{ width: `${20}%` }} className="usage relative h-3 rounded-sm">
        <div
          style={{ width: `${exceededProgress}%` }}
          className="absolute h-full rounded-l-sm bg-red-500"
        >
          <Legend text="Current:" value={numberOfCurrentRuns} position="topRow1" />
        </div>
        <div
          style={{ width: `${currentProgress}%` }}
          className="absolute h-full rounded-l-sm bg-green-600"
        />
      </div>
    </div>
  );
}

const positions = {
  topRow1: "bottom-0 h-9",
  topRow2: "bottom-0 h-14",
  bottomRow1: "top-0 h-9 items-end",
  bottomRow2: "top-0 h-14 items-end",
};

type LegendProps = {
  text: string;
  value: number;
  position: "topRow1" | "topRow2" | "bottomRow1" | "bottomRow2";
};

function Legend({ text, value, position }: LegendProps) {
  return (
    <div
      className={cn("absolute left-full z-10 flex border-l border-slate-400", positions[position])}
    >
      <Paragraph className="h-fit whitespace-nowrap bg-background px-1.5 text-xs text-dimmed">
        {text}
        <span className="ml-1 text-bright">{value}</span>
      </Paragraph>
    </div>
  );
}
