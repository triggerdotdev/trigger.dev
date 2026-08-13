import { useState } from "react";
import {
  DateTime,
  DateTimeAccurate,
  DateTimeShort,
  RelativeDateTime,
  SmartDateTime,
} from "~/components/primitives/DateTime";
import { PrettyDuration } from "~/components/primitives/PrettyDuration";
import { LiveCountdown, LiveCountUp, LiveTimer } from "~/components/runs/v3/LiveTimer";
import { Story, StoryGrid, StoryPage, StorySection } from "../storybook/StoryKit";

/* A fixed moment so the formatting variants are comparable at a glance. */
const SAMPLE = new Date("2026-08-12T09:24:03.256Z");
const SAMPLE_EARLIER = new Date("2026-08-12T09:23:41.881Z");
const SAMPLE_PREVIOUS_DAY = new Date("2026-08-11T22:10:00.000Z");

export default function Story_() {
  // Anchored on mount so the live components have something to count against.
  const [mountedAt] = useState(() => new Date(Date.now() - 83_000));
  const [countdownEnd] = useState(() => new Date(Date.now() + 95_000));

  return (
    <StoryPage
      componentNames={["DateTime.tsx", "PrettyDuration.tsx", "LiveTimer.tsx"]}
      title="Dates & timers"
      description="Every date formatting component, plus the live-updating timers used on run rows."
    >
      <StorySection title="DateTime" description="The standard formatter; hover for the tooltip.">
        <StoryGrid min="16rem">
          <Story label="Default">
            <DateTime date={SAMPLE} />
          </Story>
          <Story label="includeSeconds">
            <DateTime date={SAMPLE} includeSeconds />
          </Story>
          <Story label="includeTime={false}">
            <DateTime date={SAMPLE} includeTime={false} />
          </Story>
          <Story label="showTimezone">
            <DateTime date={SAMPLE} showTimezone />
          </Story>
          <Story label="hour12={false}">
            <DateTime date={SAMPLE} hour12={false} />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="Variants">
        <StoryGrid min="16rem">
          <Story label="DateTimeAccurate (ms)">
            <DateTimeAccurate date={SAMPLE} />
          </Story>
          <Story label="DateTimeShort">
            <DateTimeShort date={SAMPLE} />
          </Story>
          <Story label="SmartDateTime (same day as previous)">
            <SmartDateTime date={SAMPLE} previousDate={SAMPLE_EARLIER} />
          </Story>
          <Story label="SmartDateTime (new day)">
            <SmartDateTime date={SAMPLE} previousDate={SAMPLE_PREVIOUS_DAY} />
          </Story>
          <Story label="RelativeDateTime">
            <RelativeDateTime date={SAMPLE_PREVIOUS_DAY} />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection title="PrettyDuration">
        <StoryGrid min="16rem">
          <Story label="22.4s">
            <PrettyDuration startAt={SAMPLE_EARLIER} endAt={SAMPLE} />
          </Story>
          <Story label="11h 14m">
            <PrettyDuration startAt={SAMPLE_PREVIOUS_DAY} endAt={SAMPLE} />
          </Story>
          <Story label="Missing dates → fallback">
            <PrettyDuration startAt={null} endAt={null} fallback="Not started" />
          </Story>
        </StoryGrid>
      </StorySection>

      <StorySection
        title="Live timers"
        description="Update in place — used while a run is executing."
      >
        <StoryGrid min="16rem">
          <Story label="LiveTimer (running)">
            <LiveTimer startTime={mountedAt} />
          </Story>
          <Story label="LiveTimer (ended)">
            <LiveTimer startTime={SAMPLE_EARLIER} endTime={SAMPLE} />
          </Story>
          <Story label="LiveCountUp">
            <LiveCountUp lastUpdated={mountedAt} />
          </Story>
          <Story label="LiveCountdown">
            <LiveCountdown endTime={countdownEnd} />
          </Story>
        </StoryGrid>
      </StorySection>
    </StoryPage>
  );
}
