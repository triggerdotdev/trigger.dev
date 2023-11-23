import * as Slider from "@radix-ui/react-slider";
import { Header2 } from "../primitives/Headers";
import { Paragraph } from "../primitives/Paragraph";
import { DefinitionTip } from "../DefinitionTooltip";

export function PricingCalculator() {
  return (
    <div className="w-full">
      <ConcurrentRunsSlider />
    </div>
  );
}

const concurrentRuns = [
  { 5: "Up to 5" },
  { 20: "Up to 20" },
  { 50: "Up to 50" },
  { 100: "Up to 100" },
];

const lastItemConcurrentRuns = concurrentRuns[concurrentRuns.length - 1];
const maxItemsConcurrentRuns = Number(Object.keys(lastItemConcurrentRuns)[0]);
const stepConcurrentRuns = concurrentRuns.length;

function ConcurrentRunsSlider() {
  return (
    <form>
      <div className="flex">
        <div className="flex w-full flex-col">
          <div className="flex items-center justify-between">
            <Header2>
              <DefinitionTip
                content={"Get in touch if you need more than 100 concurrent Runs"}
                title={"Concurrent Runs"}
              >
                Concurrent Runs
              </DefinitionTip>
            </Header2>
            <Header2>Up to 5</Header2>
          </div>
          <Slider.Root
            className="relative mb-2 mt-4 flex h-5 w-full touch-none select-none items-center"
            defaultValue={[0]}
            max={maxItemsConcurrentRuns}
            step={stepConcurrentRuns}
          >
            <Slider.Track className="relative h-[8px] grow rounded-full bg-slate-850">
              <Slider.Range className="absolute h-full rounded-full bg-indigo-500" />
            </Slider.Track>
            <Slider.Thumb
              className="block h-5 w-5 rounded-full border-4 border-indigo-500 bg-slate-850 shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] transition hover:border-indigo-400 hover:bg-slate-800 focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] focus:outline-none"
              aria-label="Concurrent Runs slider"
            />
          </Slider.Root>
          <div className="-ml-1 flex w-[calc(100%+2rem)] items-center justify-between">
            {concurrentRuns.map((run, i) => {
              const concurrrentRunsLabels = Object.values(run)[0];
              return (
                <Paragraph variant="extra-small" key={i}>
                  {concurrrentRunsLabels}
                </Paragraph>
              );
            })}
          </div>
        </div>
        <div className="flex h-full items-start text-dimmed">
          <span className="mx-6">=</span>$30
        </div>
      </div>
      <hr className="mt-6 border-border" />
    </form>
  );
}
