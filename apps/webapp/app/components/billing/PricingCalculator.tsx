import * as Slider from "@radix-ui/react-slider";
import { Header2 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import { DefinitionTip } from "../DefinitionTooltip";

export function PricingCalculator() {
  return (
    <div className="flex w-full flex-col gap-4">
      <ConcurrentRunsSlider />
      <RunsSlider />
      <GrandTotal />
    </div>
  );
}

const concurrentRuns = [
  { value: 5, label: "Up to 5" },
  { value: 20, label: "Up to 20" },
  { value: 50, label: "Up to 50" },
  { value: 100, label: "Up to 100" },
];

function ConcurrentRunsSlider() {
  return (
    <form>
      <div className="flex">
        <div className="flex w-full flex-col">
          <div className="flex items-center justify-between">
            <Header2>
              <DefinitionTip
                content="The number of Runs that can be executed at the same time. Get in touch if you need more than 100."
                title="Concurrent Runs"
              >
                Concurrent Runs
              </DefinitionTip>
            </Header2>
            <Header2>Up to 5</Header2>
          </div>
          <Slider.Root
            className="relative mb-2 mt-4 flex h-5 w-full touch-none select-none items-center"
            defaultValue={[0]}
            max={concurrentRuns.length - 1}
            step={1}
          >
            <Slider.Track className="relative h-[8px] grow rounded-full bg-slate-850">
              <Slider.Range className="absolute h-full rounded-full bg-indigo-500" />
            </Slider.Track>
            <Slider.Thumb
              className="block h-5 w-5 rounded-full border-4 border-indigo-500 bg-slate-850 shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] transition hover:border-indigo-400 hover:bg-slate-800 focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] focus:outline-none"
              aria-label="Concurrent Runs slider"
            />
          </Slider.Root>
          <div className="-ml-2.5 flex w-[calc(100%+2rem)] items-center justify-between">
            {concurrentRuns.map((run, i) => {
              const concurrrentRunsLabels = Object.values(run)[0];
              return (
                <Paragraph variant="extra-small" className="text-slate-600" key={i}>
                  {concurrrentRunsLabels}
                </Paragraph>
              );
            })}
          </div>
        </div>
        <div className="flex h-full items-start">
          <span className="ml-6 text-dimmed">=</span>
          <Header2 className="min-w-[8ch] text-right text-dimmed">$30.00</Header2>
        </div>
      </div>
      <hr className="mt-6 border-border" />
    </form>
  );
}

const Runs = [
  { 10_000: "10k" },
  { 20_000: "20k" },
  { 150_000: "150k" },
  { 500_000: "500k" },
  { 1_000_000: "1m" },
  { 2_500_000: "2.5m" },
  { 6_250_000: "6.25m" },
  { 6_250_001: "6.25m+" },
];

const lastItemRuns = Runs[Runs.length - 1];
const maxItemsRuns = Number(Object.keys(lastItemRuns)[0]);
const stepRuns = maxItemsRuns / Runs.length;

function RunsSlider() {
  return (
    <form>
      <div className="flex">
        <div className="flex w-full flex-col">
          <div className="flex items-center justify-between">
            <Header2>
              <DefinitionTip content="A single execution of a Job." title="Runs">
                Runs
              </DefinitionTip>
            </Header2>
            <Header2>10k</Header2>
          </div>
          <Slider.Root
            className="relative mb-2 mt-4 flex h-5 w-full touch-none select-none items-center"
            defaultValue={[0]}
            max={maxItemsRuns}
            step={stepRuns}
          >
            <Slider.Track className="relative h-[8px] grow rounded-full bg-slate-850">
              <Slider.Range className="absolute h-full rounded-full bg-indigo-500" />
            </Slider.Track>
            <Slider.Thumb
              className="block h-5 w-5 rounded-full border-4 border-indigo-500 bg-slate-850 shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] transition hover:border-indigo-400 hover:bg-slate-800 focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] focus:outline-none"
              aria-label="Concurrent Runs slider"
            />
          </Slider.Root>
          <div className="flex w-[calc(100%+1rem)] items-center justify-between">
            {Runs.map((run, i) => {
              const RunsLabels = Object.values(run)[0];
              return (
                <Paragraph variant="extra-small" className="text-slate-600" key={i}>
                  {RunsLabels}
                </Paragraph>
              );
            })}
          </div>
        </div>
        <div className="flex h-full items-start">
          <span className="ml-6 text-dimmed">=</span>
          <Header2 className="min-w-[8ch] text-right text-dimmed">$13.53</Header2>
        </div>
      </div>
      <hr className="mt-6 border-border" />
    </form>
  );
}

function GrandTotal() {
  return (
    <div className="flex justify-between">
      <Header2>Total monthly estimate</Header2>
      <Header2>$43.53</Header2>
    </div>
  );
}
