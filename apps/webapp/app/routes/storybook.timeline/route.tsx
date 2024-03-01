import * as Slider from "@radix-ui/react-slider";
import { useState } from "react";
import { Timeline } from "~/components/primitives/Timeline";

export default function Story() {
  const [scale, setScale] = useState(0.5);

  return (
    <div className="m-4 grid h-full grid-rows-[2.5rem_1fr] overflow-hidden">
      <div>
        <Slider.Root
          className="relative mb-2 mt-4 flex h-5 w-full touch-none select-none items-center"
          value={[scale]}
          onValueChange={(value) => setScale(value[0])}
          min={0}
          max={1}
          step={0.01}
        >
          <Slider.Track className="relative h-[8px] grow rounded-full bg-grid-bright">
            <Slider.Range className="absolute h-full rounded-full bg-primary" />
          </Slider.Track>
          <Slider.Thumb
            className="block h-5 w-5 rounded-full border-4 border-primary bg-charcoal-850 shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] transition hover:border-primary hover:bg-charcoal-800 focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] focus:outline-none"
            aria-label="Concurrent runs slider"
          />
        </Slider.Root>
      </div>
      <div className="overflow-x-auto bg-grid-dimmed">
        <Timeline totalDurationMs={1_000} scale={scale} tickCount={5} className="h-10" />
      </div>
    </div>
  );
}
