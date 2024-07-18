import { ArchiveBoxIcon, ArrowsRightLeftIcon } from "@heroicons/react/20/solid";
import type { ScheduleType } from "@trigger.dev/database";
import { cn } from "~/utils/cn";

export function ScheduleTypeCombo({ type, className }: { type: ScheduleType; className?: string }) {
  return (
    <div className={cn("flex items-center space-x-1", className)}>
      <ScheduleTypeIcon type={type} />
      <span>{scheduleTypeName(type)}</span>
    </div>
  );
}

export function ScheduleTypeIcon({ type }: { type: ScheduleType }) {
  switch (type) {
    case "IMPERATIVE":
      return <ArrowsRightLeftIcon className="size-4" />;
    case "DECLARATIVE":
      return <ArchiveBoxIcon className="size-4" />;
  }
}
export function scheduleTypeName(type: ScheduleType) {
  switch (type) {
    case "IMPERATIVE":
      return "Imperative";
    case "DECLARATIVE":
      return "Declarative";
  }
}
