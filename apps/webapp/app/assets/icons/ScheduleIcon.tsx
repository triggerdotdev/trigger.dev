import { CalendarDaysIcon } from "@heroicons/react/24/solid";
import { cn } from "~/utils/cn";

export function ScheduleIcon({ className }: { className?: string }) {
  return <CalendarDaysIcon className={cn("text-sky-500", className)} />;
}
