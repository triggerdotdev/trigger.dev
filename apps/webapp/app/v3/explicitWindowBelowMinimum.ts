import { parseScheduleWindow } from "@trigger.dev/core/v3";
import { parseExpression } from "cron-parser";

export function explicitWindowBelowMinimum({
  explicitWindow,
  cron,
  timezone,
  minimumWindowDurationSeconds,
  referenceTime = new Date(),
}: {
  explicitWindow: string;
  cron: string;
  timezone?: string | null;
  minimumWindowDurationSeconds: number;
  referenceTime?: Date;
}): boolean {
  try {
    const window = parseScheduleWindow(explicitWindow);
    if (window.type === "duration") {
      return window.durationSeconds < minimumWindowDurationSeconds;
    }
    const expression = parseExpression(cron, {
      currentDate: referenceTime,
      utc: timezone == null,
      tz: timezone ?? undefined,
    });
    let previous = expression.next().getTime();
    // Feedback samples four upcoming gaps; runtime enforces the minimum for every occurrence.
    for (let index = 0; index < 4; index++) {
      const next = expression.next().getTime();
      if (((next - previous) * window.percentage) / 100 < minimumWindowDurationSeconds * 1_000) {
        return true;
      }
      previous = next;
    }
    return false;
  } catch {
    return false;
  }
}
