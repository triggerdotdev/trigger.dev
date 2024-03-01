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
      <div className="overflow-x-auto bg-grid-dimmed">
        <div className="px-4">
          <Timeline
            totalDurationMs={durationMs}
            scale={scale}
            className="h-9 bg-rose-500/10"
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
            className="h-9 bg-rose-500/10"
            tickCount={tickCount}
            renderTick={({}) => <div className="h-full w-px bg-charcoal-600"></div>}
          />
        </div>
      </div>
    </div>
  );
}
