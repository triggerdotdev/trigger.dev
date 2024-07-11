import * as Slider from "@radix-ui/react-slider";
import { Plans, estimate } from "@trigger.dev/platform/v2";
import { useCallback, useState } from "react";
import { DefinitionTip } from "../../DefinitionTooltip";
import { Header2 } from "../../primitives/Headers";
import { Paragraph } from "../../primitives/Paragraph";
import { formatCurrency, formatNumberCompact } from "~/utils/numberFormatter";
import { cn } from "~/utils/cn";

export function PricingCalculator({ plans }: { plans: Plans }) {
  const [selectedConcurrencyIndex, setSelectedConcurrencyIndex] = useState(0);
  const concurrentRunTiers = [
    { code: "free", upto: plans.free.concurrentRuns?.freeAllowance! },
    ...(plans.paid.concurrentRuns?.pricing?.tiers ?? []),
  ];
  const [runs, setRuns] = useState(0);
  const runBrackets = [
    ...(plans.paid.runs?.pricing?.brackets.map((b, index, arr) => ({
      unitCost: b.unitCost,
      from: index === 0 ? 0 : arr[index - 1].upto! + 1,
      upto: b.upto ?? arr[index - 1].upto! * 10,
    })) ?? []),
  ];

  const result = estimate({
    usage: { runs, concurrent_runs: concurrentRunTiers[selectedConcurrencyIndex].upto - 1 },
    plans: [plans.free, plans.paid],
  });

  return (
    <div className="flex w-full flex-col gap-4">
      <ConcurrentRunsSlider
        options={concurrentRunTiers}
        selectedIndex={selectedConcurrencyIndex}
        setSelectedIndex={setSelectedConcurrencyIndex}
        cost={result?.cost.concurrentRunCost ?? 0}
      />
      <RunsSlider
        brackets={runBrackets}
        runs={runs}
        setRuns={setRuns}
        cost={result?.cost.runsCost ?? 0}
      />
      <GrandTotal cost={result?.cost.total ?? 0} />
    </div>
  );
}

function ConcurrentRunsSlider({
  options,
  selectedIndex,
  setSelectedIndex,
  cost,
}: {
  options: {
    code: string;
    upto: number;
  }[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  cost: number;
}) {
  const selectedOption = options[selectedIndex];

  return (
    <div>
      <div className="flex">
        <div className="flex w-full flex-col">
          <div className="flex items-center justify-between">
            <Header2>
              <DefinitionTip
                content="The number of runs that can be executed at the same time. Get in touch if you need more than 100."
                title="Concurrent runs"
              >
                Concurrent runs
              </DefinitionTip>
            </Header2>
            <Header2>Up to {selectedOption.upto}</Header2>
          </div>
          <Slider.Root
            className="relative mb-2 mt-4 flex h-5 w-full touch-none select-none items-center"
            value={[selectedIndex]}
            onValueChange={(value) => setSelectedIndex(value[0])}
            max={options.length - 1}
            step={1}
          >
            <Slider.Track className="relative h-[8px] grow rounded-full bg-grid-bright">
              <Slider.Range className="absolute h-full rounded-full bg-primary" />
            </Slider.Track>
            <Slider.Thumb
              className="block h-5 w-5 rounded-full border-4 border-primary bg-charcoal-850 shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] transition hover:border-primary hover:bg-charcoal-800 focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] focus:outline-none"
              aria-label="Concurrent runs slider"
            />
          </Slider.Root>
          <div className="ml-1.5 flex w-[99.85%] items-center justify-between">
            {options.map((tier, i) => {
              return (
                <Paragraph variant="extra-small" key={i}>
                  {tier.upto}
                </Paragraph>
              );
            })}
          </div>
        </div>
        <div className="flex h-full items-start">
          <span className="ml-6 text-text-dimmed">=</span>
          <Header2 className="min-w-[8ch] text-right text-text-dimmed">
            {formatCurrency(cost, true)}
          </Header2>
        </div>
      </div>
      <hr className="mt-6 border-grid-bright" />
    </div>
  );
}

const runIncrements = 10_000;
function RunsSlider({
  brackets,
  runs,
  setRuns,
  cost,
}: {
  brackets: {
    from: number;
    upto: number;
    unitCost: number;
  }[];
  runs: number;
  setRuns: (value: number) => void;
  cost: number;
}) {
  const [value, setValue] = useState(0);

  const updateRuns = useCallback((value: number) => {
    setValue(value);
    const r = calculateRuns(value / runIncrements, brackets);
    setRuns(r);
  }, []);

  return (
    <div>
      <div className="flex">
        <div className="flex w-full flex-col">
          <div className="flex items-center justify-between">
            <Header2>
              <DefinitionTip content="A single execution of a Job." title="Runs">
                Runs
              </DefinitionTip>
            </Header2>
            <Header2>{formatNumberCompact(runs)}</Header2>
          </div>
          <Slider.Root
            className="relative mb-2 mt-4 flex h-5 w-full touch-none select-none items-center"
            value={[value]}
            onValueChange={(value) => updateRuns(value[0])}
            max={runIncrements}
            step={1}
          >
            <Slider.Track className="relative h-[8px] grow rounded-full bg-grid-bright">
              <Slider.Range className="absolute h-full rounded-full bg-primary" />
            </Slider.Track>
            <Slider.Thumb
              className="block h-5 w-5 rounded-full border-4 border-primary bg-charcoal-850 shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] transition hover:border-primary hover:bg-charcoal-800 focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] focus:outline-none"
              aria-label="Concurrent runs slider"
            />
          </Slider.Root>
          <div className="relative w-full">
            {brackets.map((bracket, i, arr) => {
              const percentagePerBracket = 1 / arr.length;
              return (
                <SliderMarker
                  key={i}
                  percentage={(i / (arr.length - 1)) * percentagePerBracket * (arr.length - 1)}
                  alignment={i === 0 ? "left" : "center"}
                  text={formatNumberCompact(bracket.from)}
                />
              );
            })}
            <SliderMarker
              percentage={1}
              alignment={"right"}
              text={formatNumberCompact(brackets[brackets.length - 1].upto)}
            />
          </div>
        </div>
        <div className="flex h-full items-start">
          <span className="ml-6 text-text-dimmed">=</span>
          <Header2 className="min-w-[8ch] text-right text-text-dimmed">
            {formatCurrency(cost, true)}
          </Header2>
        </div>
      </div>
      <hr className="mt-6 border-grid-bright" />
    </div>
  );
}

function calculateRuns(percentage: number, brackets: { from: number; upto: number }[]) {
  //first we find which bucket we're in
  const buckets = brackets.length;
  const bucket = Math.min(Math.floor(percentage * buckets), brackets.length - 1);
  const percentagePerBucket = 1 / buckets;

  //relevant bracket
  let bracket = brackets[bucket];
  const from = bracket.from;
  const upto = bracket.upto;

  //how far as we into the bracket
  const percentageIntoBracket = (percentage - bucket * percentagePerBucket) / percentagePerBucket;

  //calculate the runs
  const runs = Math.floor(from + (upto - from) * percentageIntoBracket);
  return runs;
}

function GrandTotal({ cost }: { cost: number }) {
  return (
    <div className="flex justify-between">
      <Header2>Total monthly estimate</Header2>
      <Header2>{formatCurrency(cost, true)}</Header2>
    </div>
  );
}

function SliderMarker({
  percentage,
  alignment,
  text,
}: {
  percentage: number;
  alignment: "left" | "center" | "right";
  text: string;
}) {
  return (
    <div
      className="absolute top-0 h-4"
      style={{
        left: `${percentage * 100}%`,
      }}
    >
      <div
        className={cn(
          "absolute flex items-center",
          alignment === "left"
            ? "left-0 justify-start"
            : alignment === "center"
            ? "-translate-x-1/2 justify-center"
            : "justify-middle right-0"
        )}
      >
        <Paragraph variant="extra-small">{text}</Paragraph>
      </div>
    </div>
  );
}
