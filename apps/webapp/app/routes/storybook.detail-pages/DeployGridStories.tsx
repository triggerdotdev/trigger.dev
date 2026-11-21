import { useState } from "react";
import { type DayDeployment } from "~/components/deployments/DeployActivityGrid";
import { type ActivityDay, gridWeeks } from "~/components/deployments/deployActivityDays";
import { DeployActivityBand } from "~/components/deployments/DeployActivityViews";
import { StorySubSection } from "../storybook/StoryKit";

/* The deployments list's activity grid with made-up data, shown open. On the real page it's
   hidden until the toolbar's Activity switch turns it on. */

const TODAY = "2026-11-20";
const PEOPLE = ["Maya Okafor", "Tomás Lindqvist", "Priya Raman", "Eric Allam"];

/** A repeatable pseudo-random stream, so the story looks the same on every load. */
function stream(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/** A year of deploys with a winter break, a freeze, a slow summer and a launch crunch. */
function madeUpDays(
  seed: number,
  { rate, freeze }: { rate: number; freeze?: [string, string] }
): ActivityDay[] {
  const random = stream(seed);
  const days: ActivityDay[] = [];
  for (const week of gridWeeks(TODAY)) {
    week.forEach((day, weekday) => {
      if (!day) return;
      let expected = weekday >= 5 ? rate * 0.05 : rate;
      if (day >= "2025-12-20" && day <= "2026-01-04") expected = 0;
      if (freeze && day >= freeze[0] && day <= freeze[1]) expected = 0;
      if (day >= "2026-07-27" && day <= "2026-08-14") expected *= 0.3;
      const crunch = day >= "2026-09-14" && day <= "2026-10-02";
      if (crunch) expected *= 3.2;
      const total = Math.floor(expected * (0.3 + 1.7 * random()) + random() * 0.9);
      if (total === 0) return;
      let failed = 0;
      for (let index = 0; index < total; index += 1) {
        if (random() < (crunch ? 0.2 : 0.07)) failed += 1;
      }
      days.push({ day, total, deployed: total - failed, failed });
    });
  }
  return days;
}

const PROD = madeUpDays(7, { rate: 0.75, freeze: ["2026-03-09", "2026-03-22"] });

/** The hover card's deploys for a day, made up from that day's counts. */
function loadDayFrom(days: ActivityDay[]) {
  return async (day: string): Promise<DayDeployment[]> => {
    const entry = days.find((candidate) => candidate.day === day);
    if (!entry) return [];
    return Array.from({ length: Math.min(entry.total, 6) }, (_, index) => {
      const number = entry.total - index;
      return {
        shortCode: `${day}-${number}`,
        version: `${day.replaceAll("-", "")}.${number}`,
        status: index < entry.failed ? ("FAILED" as const) : ("DEPLOYED" as const),
        createdAt: `${day}T${String(9 + ((number * 2) % 9)).padStart(2, "0")}:${String(
          (number * 17) % 60
        ).padStart(2, "0")}:00Z`,
        deployedBy: PEOPLE[(number + day.charCodeAt(9)) % PEOPLE.length],
        commitMessage: null,
      };
    });
  };
}

const loadProd = loadDayFrom(PROD);

export function DeployGridStory() {
  const [selectedDay, setSelectedDay] = useState<string | undefined>("2026-09-29");

  return (
    <div className="space-y-6">
      <StorySubSection title="Above the deployments list. A click on a day filters the list (here it only moves the ring).">
        <div
          className="overflow-hidden rounded-sm border border-grid-bright"
          onClickCapture={(event) => {
            const day = (event.target as HTMLElement).closest<HTMLElement>("[data-day]")?.dataset
              .day;
            if (!day) return;
            event.preventDefault();
            setSelectedDay((current) => (current === day ? undefined : day));
          }}
        >
          <DeployActivityBand
            today={TODAY}
            days={PROD}
            loadDay={loadProd}
            selectedDay={selectedDay}
            dayHref={(day) => `#${day}`}
            failedHref="#failed"
          />
        </div>
      </StorySubSection>
      <StorySubSection title="An environment that hasn't deployed in the last 12 months">
        <div className="overflow-hidden rounded-sm border border-grid-bright">
          <DeployActivityBand today={TODAY} days={[]} />
        </div>
      </StorySubSection>
    </div>
  );
}
