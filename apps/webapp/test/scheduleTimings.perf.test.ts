import { calculateEffectiveScheduleTime, calculateSchedulePhase } from "@internal/schedule-engine";
import { parseExpression } from "cron-parser";
import { describe, expect, it } from "vitest";
import { resolveScheduleTimings, type ScheduleTimingInput } from "~/v3/scheduleTimings.server";

const PHASE_SECRET = "bench-phase-secret";
const PAGE_SIZE = 100;

/**
 * The shape this path had before the optimization: for every row, walk the
 * cron backwards once for `lastRun` and forwards twice for the next two
 * nominal times, re-parsing the expression each time.
 */
function legacyResolve(inputs: ScheduleTimingInput[], now: Date) {
  return inputs.map((input) => {
    let lastRun: Date | undefined;
    if (input.active) {
      try {
        const previous = parseExpression(input.cron, {
          currentDate: now,
          utc: input.timezone === null,
          tz: input.timezone ?? undefined,
        })
          .prev()
          .toDate();
        lastRun = previous.getTime() > input.updatedAt.getTime() ? previous : undefined;
      } catch {
        lastRun = undefined;
      }
    }

    const nominalTimes: Date[] = [];
    let cursor = now;
    for (let i = 0; i < 2; i++) {
      cursor = parseExpression(input.cron, {
        currentDate: cursor,
        utc: input.timezone === null,
        tz: input.timezone ?? undefined,
      })
        .next()
        .toDate();
      nominalTimes.push(cursor);
    }

    const phase =
      input.schedulePhase ??
      calculateSchedulePhase({
        secret: PHASE_SECRET,
        environmentId: input.environmentId,
        deduplicationKey: input.deduplicationKey,
      });

    const { effectiveAt } = calculateEffectiveScheduleTime({
      nominalAt: nominalTimes[0],
      nextNominalAt: nominalTimes[1],
      schedulePhase: phase,
      window: undefined,
    });

    return { nextRun: nominalTimes[0], nextRunEffectiveAt: effectiveAt, lastRun };
  });
}

function page(crons: Array<[string, string | null]>): ScheduleTimingInput[] {
  return Array.from({ length: PAGE_SIZE }, (_, index) => {
    const [cron, timezone] = crons[index % crons.length];
    return {
      cron,
      timezone,
      deduplicationKey: `dedup-${index}`,
      environmentId: `env-${index % 5}`,
      schedulePhase: null,
      windowDurationSeconds: null,
      windowPercentage: null,
      active: true,
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
    };
  });
}

function timeIt(label: string, fn: () => unknown): number {
  fn();
  const started = process.hrtime.bigint();
  fn();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // eslint-disable-next-line no-console
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms / ${PAGE_SIZE} rows`);
  return ms;
}

const SCENARIOS: Array<{
  name: string;
  crons: Array<[string, string | null]>;
  minSpeedup: number;
}> = [
  {
    name: "one shared UTC expression",
    crons: [["0 0 * * *", null]],
    minSpeedup: 30,
  },
  {
    name: "one shared timezone expression",
    crons: [["0 9 * * 1-5", "Europe/London"]],
    minSpeedup: 100,
  },
  {
    name: "a handful of timezone expressions",
    crons: [
      ["0 0 * * *", "America/New_York"],
      ["0 9 * * 1-5", "Europe/London"],
      ["30 2 1 * *", "Asia/Tokyo"],
      ["15 3 * * 0", "Australia/Sydney"],
    ],
    minSpeedup: 50,
  },
  {
    name: "sparse expressions (worst case)",
    crons: [
      ["0 0 1 1 *", "America/New_York"],
      ["0 0 29 2 *", "America/New_York"],
    ],
    minSpeedup: 20,
  },
  {
    name: "every row distinct (no cache hits)",
    crons: Array.from(
      { length: PAGE_SIZE },
      (_, index) =>
        [`${index % 60} ${Math.floor(index / 60)} * * *`, "Europe/London"] as [
          string,
          string | null,
        ]
    ),
    minSpeedup: 4,
  },
];

describe("resolveScheduleTimings CPU", () => {
  const now = new Date("2024-06-15T09:17:23.000Z");

  it.each(SCENARIOS)(
    "beats the pre-optimization shape by at least $minSpeedup x: $name",
    ({ name, crons, minSpeedup }) => {
      const inputs = page(crons);

      // eslint-disable-next-line no-console
      console.log(`\n${name}`);
      const legacy = timeIt("legacy (per-row, with lastRun)", () => legacyResolve(inputs, now));
      const optimized = timeIt("optimized (API path)", () =>
        resolveScheduleTimings(inputs, { phaseSecret: PHASE_SECRET, includeLastRun: false, now })
      );
      const withLastRun = timeIt("optimized (dashboard path)", () =>
        resolveScheduleTimings(inputs, { phaseSecret: PHASE_SECRET, includeLastRun: true, now })
      );

      // eslint-disable-next-line no-console
      console.log(
        `  => ${(legacy / optimized).toFixed(1)}x faster on the API path, ` +
          `${(legacy / withLastRun).toFixed(1)}x with lastRun`
      );

      expect(legacy / optimized).toBeGreaterThan(minSpeedup);
      expect(withLastRun).toBeLessThan(legacy * 1.25);
    }
  );
});
