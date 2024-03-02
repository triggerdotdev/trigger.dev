import * as Slider from "@radix-ui/react-slider";
import { formatDurationMilliseconds } from "@trigger.dev/core/v3";
import { ReactNode, useState } from "react";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Switch } from "~/components/primitives/Switch";
import {
  Timeline,
  Root,
  Point,
  Row,
  Span,
  EquallyDistribute,
} from "~/components/primitives/Timeline";
import { cn } from "~/utils/cn";

const maxDuration = 20_000;

export default function Story() {
  const [scale, setScale] = useState(0.5);
  const [durationScale, setDurationScale] = useState(0.2);
  const [tickCount, setTickCount] = useState(5);
  const [showDuration, setShowDurations] = useState(false);

  const durationMs = maxDuration * durationScale;

  return (
    <div className="m-4 grid h-full grid-rows-[4rem_1fr] overflow-hidden">
      <div className="flex items-center gap-2">
        <div className="flex flex-col gap-0.5">
          <Paragraph>Scale</Paragraph>
          <Slider.Root
            className="relative flex h-3 w-72 touch-none select-none items-center"
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
        <div className="flex flex-col gap-0.5">
          <Paragraph>
            Duration {formatDurationMilliseconds(durationMs, { style: "short" })}
          </Paragraph>
          <Slider.Root
            className="relative flex h-3 w-72 touch-none select-none items-center"
            value={[durationScale]}
            onValueChange={(value) => setDurationScale(value[0])}
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
        <Switch
          checked={showDuration}
          onCheckedChange={setShowDurations}
          variant="small"
          label={"Show durations"}
        />
      </div>
      {/* <div className="grid grid-cols-[100px_1fr] bg-grid-dimmed">
        <div></div>
        <div className="overflow-x-auto border-l border-charcoal-600 bg-grid-dimmed">
          <div className="pr-6">
            <Timeline
              totalDurationMs={durationMs}
              scale={scale}
              className="h-9"
              tickCount={tickCount}
              renderTick={({ index, durationMs }) => (
                <div className="relative h-full">
                  <div
                    className={cn(
                      "absolute bottom-0 text-xxs text-text-dimmed",
                      index === 0 ? "left-0.5" : "left-1/2 -translate-x-1/2"
                    )}
                  >
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
              renderTick={({ index }) => {
                if (index === 0) return null;
                return <div className="h-full w-px bg-charcoal-600"></div>;
              }}
              spanStartMs={36}
              spanDurationMs={287}
              renderSpan={() => <Span durationMs={287} showDuration={showDuration} />}
            />
            <Timeline
              totalDurationMs={durationMs}
              scale={scale}
              className="group h-9 hover:bg-charcoal-500/50"
              tickCount={tickCount}
              renderTick={({ index }) => {
                if (index === 0) return null;
                return <div className="h-full w-px bg-charcoal-600"></div>;
              }}
              spanStartMs={36 + 287 + 5}
              spanDurationMs={100}
              renderSpan={() => <Span durationMs={100} showDuration={showDuration} />}
            />
            <Timeline
              totalDurationMs={durationMs}
              scale={scale}
              className="group h-9 hover:bg-charcoal-500/50"
              tickCount={tickCount}
              renderTick={({ index }) => {
                if (index === 0) return null;
                return <div className="h-full w-px bg-charcoal-600"></div>;
              }}
              spanStartMs={36 + 287 + 5 + 100 + 2}
              spanDurationMs={1}
              renderSpan={() => <Span durationMs={1} showDuration={showDuration} />}
            />
            <Timeline
              totalDurationMs={durationMs}
              scale={scale}
              className="group h-9 hover:bg-charcoal-500/50"
              tickCount={tickCount}
              renderTick={({ index }) => {
                if (index === 0) return null;
                return <div className="h-full w-px bg-charcoal-600"></div>;
              }}
              spanStartMs={36 + 287 + 5 + 100 + 2 + 1 + 2}
              spanDurationMs={40}
              renderSpan={() => <Span durationMs={40} showDuration={showDuration} />}
            />
          </div>
        </div>
      </div> */}

      <div className="grid grid-cols-[100px_1fr]">
        <div></div>
        <div className="overflow-x-auto border-l border-grid-dimmed bg-background-bright">
          <div className="pr-6">
            <Root
              durationMs={durationMs}
              scale={scale}
              className="h-full"
              minWidth={300}
              maxWidth={2000}
            >
              <Row className="flex h-9 items-end border-b">
                <EquallyDistribute count={tickCount}>
                  {(ms: number, index: number) => (
                    <Point ms={ms} className={"relative bottom-0 text-xxs text-text-dimmed"}>
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
                    </Point>
                  )}
                </EquallyDistribute>
              </Row>
              <Row className="h-full">
                <EquallyDistribute count={tickCount}>
                  {(ms: number, index: number) => {
                    if (index === 0) return null;
                    return <Point ms={ms} className={"h-full border-r border-grid-dimmed"} />;
                  }}
                </EquallyDistribute>
                <Row className="group flex h-9 items-center border-b border-b-white/10 hover:bg-grid-dimmed">
                  <Span startMs={100} durationMs={232} className="h-5 rounded-sm bg-blue-500" />
                  <Point
                    ms={0}
                    className="-ml-1 h-2 w-2 rounded-full border border-background-bright/70 bg-text-dimmed"
                  ></Point>
                </Row>
                <Row className="group flex h-9 items-center border-b border-b-white/10 hover:bg-grid-dimmed">
                  <Span
                    startMs={100}
                    durationMs={232}
                    className="flex h-5 items-center rounded-sm bg-blue-500"
                  ></Span>
                  <Point
                    ms={100}
                    className="-ml-1 h-2 w-2 rounded-full border border-background-bright/70 bg-text-dimmed"
                  ></Point>
                  <Point
                    ms={200}
                    className="-ml-1 h-2 w-2 rounded-full border border-background-bright/70 bg-text-dimmed"
                  />
                </Row>
                <Row className="group flex h-9 items-center border-b border-b-white/10 hover:bg-grid-dimmed">
                  <Point
                    ms={200}
                    className="-ml-1 h-2 w-2 rounded-full border border-background-bright/70 bg-text-dimmed"
                  ></Point>
                </Row>
              </Row>
            </Root>
          </div>
        </div>
      </div>
    </div>
  );
}

function SpanComp({ durationMs, showDuration }: { durationMs: number; showDuration: boolean }) {
  return (
    <div className="relative mt-2 flex h-5 w-full items-center rounded-sm bg-blue-500">
      <div
        className={cn(
          "sticky left-0 z-10 transition group-hover:opacity-100",
          !showDuration && "opacity-0"
        )}
      >
        <div className="rounded-sm px-1 py-0.5 text-xxs text-text-bright text-shadow-custom">
          {formatDurationMilliseconds(durationMs, {
            style: "short",
            maxDecimalPoints: durationMs < 1000 ? 0 : 1,
          })}
        </div>
      </div>
    </div>
  );
}
