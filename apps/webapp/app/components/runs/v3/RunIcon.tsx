import { ClockIcon, FolderIcon, InformationCircleIcon } from "@heroicons/react/20/solid";
import { AttemptIcon } from "~/assets/icons/AttemptIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { cn } from "~/utils/cn";

type TaskIconProps = {
  name: string | undefined;
  className?: string;
};

export function RunIcon({ name, className }: TaskIconProps) {
  if (!name) return <InformationCircleIcon className={cn(className, "h-4 w-4 text-slate-800")} />;

  switch (name) {
    case "task":
      return <TaskIcon className={cn(className, "text-blue-500")} />;
    case "attempt":
      return <AttemptIcon className={cn(className, "text-slate-700")} />;
    case "wait":
      return <ClockIcon className={cn(className, "text-teal-500")} />;
  }

  return (
    <NamedIcon
      name={name}
      className={cn(className)}
      fallback={<InformationCircleIcon className={cn(className, "text-slate-800")} />}
    />
  );
}
