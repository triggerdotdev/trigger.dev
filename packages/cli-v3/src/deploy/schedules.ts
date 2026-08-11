import type { GetDeploymentResponseBody } from "@trigger.dev/core/v3";

type DeploymentWorker = NonNullable<GetDeploymentResponseBody["worker"]>;
export type DeclarativeScheduleSummary = NonNullable<
  DeploymentWorker["declarativeSchedules"]
>[number];

export function formatDeclarativeScheduleOutput(schedules: DeclarativeScheduleSummary[]): string[] {
  if (schedules.length === 0) {
    return [];
  }

  const lines = ["Declarative schedules"];

  for (const schedule of schedules) {
    lines.push(
      `  ${schedule.task}: ${schedule.cron} (${schedule.timezone}) | window ${
        schedule.window ?? "default 60s"
      } | ${formatTime(schedule.nextRun)} -> ${formatTime(schedule.nextRunEffectiveAt)}`
    );
  }

  const defaultWindowCount = schedules.filter((schedule) => schedule.window === undefined).length;
  if (defaultWindowCount > 0) {
    lines.push("");
    lines.push(
      `Tip: ${defaultWindowCount} declarative schedule${defaultWindowCount === 1 ? "" : "s"} ${
        defaultWindowCount === 1 ? "uses" : "use"
      } the default 60-second placement range. Add window: "30m" to the cron object to spread starts over a wider range.`
    );
  }

  return lines;
}

function formatTime(value: Date) {
  return value
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}
