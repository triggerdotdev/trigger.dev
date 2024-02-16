import {
  ClockIcon,
  FolderIcon,
  HandRaisedIcon,
  InformationCircleIcon,
  Squares2X2Icon,
} from "@heroicons/react/20/solid";
import { AttemptIcon } from "~/assets/icons/AttemptIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { cn } from "~/utils/cn";

type TaskIconProps = {
  name: string | undefined;
  className?: string;
};

export function RunIcon({ name, className }: TaskIconProps) {
  if (!name) return <Squares2X2Icon className={cn(className, "h-4 w-4 text-slate-700")} />;

  switch (name) {
    case "task":
      return <TaskIcon className={cn(className, "text-blue-500")} />;
    case "attempt":
      return <AttemptIcon className={cn(className, "text-slate-700")} />;
    case "wait":
      return <ClockIcon className={cn(className, "text-teal-500")} />;
    case "trace":
      return <Squares2X2Icon className={cn(className, "text-slate-700")} />;
    //log levels
    case "debug":
    case "log":
    case "info":
      return <InformationCircleIcon className={cn(className, "text-slate-700")} />;
    case "warn":
      return <InformationCircleIcon className={cn(className, "text-amber-400")} />;
    case "error":
      return <InformationCircleIcon className={cn(className, "text-rose-500")} />;
    case "fatal":
      return <HandRaisedIcon className={cn(className, "text-rose-800")} />;
  }

  return (
    <NamedIcon
      name={name}
      className={cn(className)}
      fallback={<InformationCircleIcon className={cn(className, "text-slate-700")} />}
    />
  );
}
