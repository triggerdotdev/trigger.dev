import * as Slider from "@radix-ui/react-slider";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { useState } from "react";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Switch } from "~/components/primitives/Switch";
import * as Timeline from "~/components/primitives/Timeline";
import { SpanProps } from "~/components/primitives/Timeline";
import { cn } from "~/utils/cn";

const maxDuration = 10_000;

type Element = {
  span?: {
    startMs: number;
    durationMs: number;
  };
  points?: {
    ms: number;
  }[];
};

const elements: Element[] = [
  {
    span: {
      startMs: 0,
      durationMs: 1_121,
    },
  },
  {
    span: {
      startMs: 19,
      durationMs: 1_121 - 19,
    },
  },
  {
    span: {
      startMs: 19 + 22,
      durationMs: 412,
    },
  },
  {
    span: {
      startMs: 19 + 22 + 3,
      durationMs: 412 - 3,
    },
    points: [
      {
        ms: 19 + 22 + 3 + 412 - 3,
      },
    ],
  },
  {
    points: [
      {
        ms: 19 + 22 + 3 + 94,
      },
    ],
  },
  {
    span: {
      startMs: 19 + 22 + 3 + 94 + 3,
      durationMs: 3,
    },
  },
  {
    span: {
      startMs: 19 + 22 + 3 + 94 + 3 + 3,
      durationMs: 39,
    },
  },
  {
    span: {
      startMs: 19 + 22 + 3 + 94 + 3 + 3 + 40,
      durationMs: 192,
    },
  },
];

export default function Story() {
  const [scale, setScale] = useState(0.25);
  const [durationScale, setDurationScale] = useState(0.12);
  const [tickCount, setTickCount] = useState(5);
  const [showDuration, setShowDurations] = useState(true);

  const durationMs = maxDuration * durationScale;

  return (
    <div className="m-4 grid h-full grid-rows-[auto_1fr] overflow-hidden">
      <div className="flex flex-col gap-2 pb-4">
        <div className="flex flex-col gap-0.5">
          <Paragraph variant="extra-small">Scale</Paragraph>
          <Slider.Root
            className="relative flex h-2 w-72 touch-none select-none items-center"
            value={[scale]}
            onValueChange={(value) => setScale(value[0])}
            min={0}
            max={1}
            step={0.01}
          >
            <Slider.Track className="relative h-[3px] grow rounded-full bg-grid-bright">
              <Slider.Range className="absolute h-full rounded-full bg-secondary" />
            </Slider.Track>
            <Slider.Thumb
              className="block h-2 w-2 rounded-full border-4 border-secondary bg-charcoal-850 shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] transition hover:border-secondary hover:bg-charcoal-800 focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] focus:outline-none"
              aria-label="Concurrent runs slider"
            />
          </Slider.Root>
        </div>
        <div className="flex flex-col gap-0.5">
          <Paragraph variant="extra-small">Ticks {tickCount}</Paragraph>
          <Slider.Root
            className="relative flex h-2 w-72 touch-none select-none items-center"
            value={[tickCount]}
            onValueChange={(value) => setTickCount(value[0])}
            min={2}
            max={10}
            step={1}
          >
            <Slider.Track className="relative h-[3px] grow rounded-full bg-grid-bright">
              <Slider.Range className="absolute h-full rounded-full bg-secondary" />
            </Slider.Track>
            <Slider.Thumb
              className="block h-2 w-2 rounded-full border-4 border-secondary bg-charcoal-850 shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] transition hover:border-secondary hover:bg-charcoal-800 focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] focus:outline-none"
              aria-label="Concurrent runs slider"
            />
          </Slider.Root>
        </div>
        <div className="flex flex-col gap-0.5">
          <Paragraph variant="extra-small">
            Duration {formatDurationMilliseconds(durationMs, { style: "short" })}
          </Paragraph>
          <Slider.Root
            className="relative flex h-2 w-72 touch-none select-none items-center"
            value={[durationScale]}
            onValueChange={(value) => setDurationScale(value[0])}
            min={0}
            max={1}
            step={0.01}
          >
            <Slider.Track className="relative h-[3px] grow rounded-full bg-grid-bright">
              <Slider.Range className="absolute h-full rounded-full bg-secondary" />
            </Slider.Track>
            <Slider.Thumb
              className="block h-2 w-2 rounded-full border-4 border-secondary bg-charcoal-850 shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] transition hover:border-secondary hover:bg-charcoal-800 focus:shadow-[0_1px_3px_4px_rgb(0_0_0_/_0.2),_0_1px_2px_-1px_rgb(0_0_0_/_0.1)] focus:outline-none"
              aria-label="Concurrent runs slider"
            />
          </Slider.Root>
        </div>
        <Switch
          checked={showDuration}
          onCheckedChange={setShowDurations}
          variant="small"
          label={"Show durations"}
        />
      </div>

      {/* The main body */}
      <div className="grid grid-cols-[100px_1fr]">
        <div></div>
        <div className="overflow-x-auto border-l border-grid-dimmed bg-background-bright">
          <div className="pr-6">
            <Timeline.Root
              durationMs={durationMs}
              scale={scale}
              className="h-full"
              minWidth={300}
              maxWidth={2000}
            >
              {/* Follows the cursor */}
              <Timeline.FollowCursor>
                {(ms) => (
                  <div className="relative z-50 flex h-full flex-col">
                    <div className="relative flex h-9 items-end">
                      <div className="absolute left-1/2 w-fit -translate-x-1/2 rounded-sm border border-charcoal-600 bg-charcoal-750 px-0.5 py-0.5 text-xxs tabular-nums text-text-bright">
                        {formatDurationMilliseconds(ms, {
                          style: "short",
                          maxDecimalPoints: ms < 1000 ? 0 : 1,
                        })}
                      </div>
                    </div>
                    <div className="w-px grow border-r border-grid-bright" />
                  </div>
                )}
              </Timeline.FollowCursor>

              {/* The duration labels */}
              <Timeline.Row className="flex h-9 items-end border-b">
                <Timeline.EquallyDistribute count={tickCount}>
                  {(ms: number, index: number) => (
                    <Timeline.Point
                      ms={ms}
                      className={"relative bottom-0 text-xxs text-text-dimmed"}
                    >
                      {(ms) => (
                        <div
                          className={
                            index === 0
                              ? "left-0.5"
                              : index === tickCount - 1
                              ? "-right-0 -translate-x-full"
                              : "left-1/2 -translate-x-1/2"
                          }
                        >
                          {formatDurationMilliseconds(ms, {
                            style: "short",
                            maxDecimalPoints: ms < 1000 ? 0 : 1,
                          })}
                        </div>
                      )}
                    </Timeline.Point>
                  )}
                </Timeline.EquallyDistribute>
              </Timeline.Row>
              {/* Main timeline body */}
              <Timeline.Row className="h-full">
                {/* The vertical tick lines */}
                <Timeline.EquallyDistribute count={tickCount}>
                  {(ms: number, index: number) => {
                    if (index === 0) return null;
                    return (
                      <Timeline.Point ms={ms} className={"h-full border-r border-grid-dimmed"} />
                    );
                  }}
                </Timeline.EquallyDistribute>
                <>
                  {elements.map((element, index) => {
                    return (
                      <Timeline.Row
                        key={index}
                        className="group flex h-9 items-center border-b border-b-white/10 hover:bg-grid-dimmed"
                        onMouseOver={() => console.log(`hover ${index}`)}
                      >
                        {element.span && (
                          <SpanWithDuration showDuration={showDuration} {...element.span} />
                        )}
                        {element.points?.map((point, pointIndex) => (
                          <Timeline.Point
                            key={pointIndex}
                            ms={point.ms}
                            className="-ml-1.5 h-3 w-3 rounded-full border-2 border-background-bright bg-text-dimmed"
                          />
                        ))}
                      </Timeline.Row>
                    );
                  })}
                </>
              </Timeline.Row>
            </Timeline.Root>
          </div>
        </div>
      </div>
    </div>
  );
}

function SpanWithDuration({ showDuration, ...props }: SpanProps & { showDuration: boolean }) {
  return (
    <Timeline.Span {...props}>
      <div className="relative flex h-5 w-full items-center rounded-sm bg-blue-500">
        <div
          className={cn(
            "sticky left-0 z-10 transition group-hover:opacity-100",
            !showDuration && "opacity-0"
          )}
        >
          <div className="rounded-sm px-1 py-0.5 text-xxs text-text-bright text-shadow-custom">
            {formatDurationMilliseconds(props.durationMs, {
              style: "short",
              maxDecimalPoints: props.durationMs < 1000 ? 0 : 1,
            })}
          </div>
        </div>
      </div>
    </Timeline.Span>
  );
}
