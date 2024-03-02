import * as Slider from "@radix-ui/react-slider";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { useState } from "react";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Timeline } from "~/components/primitives/Timeline";

export default function Story() {
  const [scale, setScale] = useState(0.5);
  const [durationMs, setDurationMs] = useState(2_346);
  const [tickCount, setTickCount] = useState(5);

  return (
    <div className="m-4 grid h-full grid-rows-[4rem_1fr] overflow-hidden">
      <div className="grid grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <Paragraph>Scale</Paragraph>
          <Slider.Root
            className="relative flex h-3 w-full touch-none select-none items-center"
            value={[scale]}
            onValueChange={(value) => setScale(value[0])}
            min={0}
            max={1}
            step={0.01}
          >
            <Slider.Track className="relative h-[3px] grow rounded-full bg-grid-bright">
              <Slider.Range className="absolute h-full rounded-full bg-primary" />
            </Slider.Track>
            <Slider.Thumb
              className="block h-3 w-3 rounded-full border-4 border-primary bg-charcoal-850 shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] transition hover:border-primary hover:bg-charcoal-800 focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] focus:outline-none"
              aria-label="Concurrent runs slider"
            />
          </Slider.Root>
        </div>
      </div>
      <div className="grid grid-cols-[200px_1fr]">
        <div></div>
        <div className="overflow-x-auto bg-grid-dimmed">
          <div className="px-6">
            <Timeline
              totalDurationMs={durationMs}
              scale={scale}
              className="h-9"
              tickCount={tickCount}
              renderTick={({ durationMs }) => (
                <div className="relative h-full">
                  <div className="absolute bottom-0 left-1/2 -translate-x-1/2 text-xxs text-text-dimmed">
                    {formatDurationMilliseconds(durationMs, {
                      style: "short",
                      maxDecimalPoints: durationMs < 1000 ? 0 : 1,
                    })}
                  </div>
                </div>
              )}
            />
            <Timeline
              totalDurationMs={durationMs}
              scale={scale}
              className="group h-9 hover:bg-charcoal-500/50"
              tickCount={tickCount}
              renderTick={({}) => <div className="h-full w-px bg-charcoal-600"></div>}
              spanStartMs={36}
              spanDurationMs={287}
              renderSpan={() => <Span durationMs={287} />}
            />
            <Timeline
              totalDurationMs={durationMs}
              scale={scale}
              className="group h-9 hover:bg-charcoal-500/50"
              tickCount={tickCount}
              renderTick={({}) => <div className="h-full w-px bg-charcoal-600"></div>}
              spanStartMs={36 + 287 + 5}
              spanDurationMs={100}
              renderSpan={() => <Span durationMs={100} />}
            />
            <Timeline
              totalDurationMs={durationMs}
              scale={scale}
              className="group h-9 hover:bg-charcoal-500/50"
              tickCount={tickCount}
              renderTick={({}) => <div className="h-full w-px bg-charcoal-600"></div>}
              spanStartMs={36 + 287 + 5 + 100 + 2}
              spanDurationMs={1}
              renderSpan={() => <Span durationMs={1} />}
            />
            <Timeline
              totalDurationMs={durationMs}
              scale={scale}
              className="group h-9 hover:bg-charcoal-500/50"
              tickCount={tickCount}
              renderTick={({}) => <div className="h-full w-px bg-charcoal-600"></div>}
              spanStartMs={36 + 287 + 5 + 100 + 2 + 1 + 2}
              spanDurationMs={40}
              renderSpan={() => <Span durationMs={40} />}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Span({ durationMs }: { durationMs: number }) {
  return (
    <div className="relative mt-2 flex h-5 w-full items-center rounded-sm bg-sky-500">
      <div className="sticky left-0 z-10 items-center rounded-sm px-2 text-xxs text-text-bright hover:visible">
        {formatDurationMilliseconds(durationMs, {
          style: "short",
          maxDecimalPoints: durationMs < 1000 ? 0 : 1,
        })}
      </div>
    </div>
  );
}
