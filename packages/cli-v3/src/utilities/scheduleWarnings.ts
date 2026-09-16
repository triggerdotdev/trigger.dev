import type { BackgroundWorkerWarning } from "@trigger.dev/core/v3";

export function formatScheduleWarnings(warnings: BackgroundWorkerWarning[], separator = "\n") {
  const messages = warnings.map((warning) => warning.message);
  if (warnings.some((warning) => warning.code === "schedule_default_window")) {
    messages.push(
      'Override the default in your task\'s cron config: { pattern: "...", window: "5m" }.'
    );
  }
  return messages.join(separator);
}
