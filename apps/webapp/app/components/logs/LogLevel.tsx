import { cn } from "~/utils/cn";
import { getLevelColor } from "~/utils/logUtils";
import type { LogEntry } from "~/presenters/v3/LogsListPresenter.server";

export function LogLevel({ level }: { level: LogEntry["level"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border px-1 py-0.5 text-xxs font-medium uppercase tracking-wider",
        getLevelColor(level)
      )}
    >
      {level}
    </span>
  );
}
