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
    case "DYNAMIC":
      return <ArrowsRightLeftIcon className="size-4" />;
    case "STATIC":
      return <ArchiveBoxIcon className="size-4" />;
  }
}
export function scheduleTypeName(type: ScheduleType) {
  switch (type) {
    case "DYNAMIC":
      return "Dynamic";
    case "STATIC":
      return "Static";
  }
}
