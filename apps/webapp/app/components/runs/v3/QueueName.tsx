import { TasksIcon } from "~/assets/icons/TasksIcon";
import { ConcurrencyIcon } from "~/assets/icons/ConcurrencyIcon";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import { RectangleStackIcon } from "@heroicons/react/20/solid";

const LIMIT_PREFIX = "limit/";
const TASK_PREFIX = "task/";

export function QueueName({
  name,
  type,
  kind,
  paused,
  className,
}: {
  name: string;
  type: "task" | "custom";
  /** "limit" rows are named concurrency limits rather than queues. */
  kind?: "queue" | "limit";
  paused?: boolean;
  className?: string;
}) {
  if (kind === "limit") {
    const displayName = name.startsWith(LIMIT_PREFIX) ? name.slice(LIMIT_PREFIX.length) : name;
    return (
      <span className={cn("flex items-center gap-1", className)}>
        <SimpleTooltip
          button={
            <ConcurrencyIcon
              className={cn("size-[1.125rem] text-amber-500", paused && "opacity-50")}
            />
          }
          content={
            displayName.startsWith(TASK_PREFIX)
              ? `This is the inline concurrency limit of your "${displayName.slice(
                  TASK_PREFIX.length
                )}" task`
              : "This is a named concurrency limit declared in your code."
          }
        />
        <span className={paused ? "opacity-50" : undefined}>{displayName}</span>
      </span>
    );
  }

  return (
    <span className={cn("flex items-center gap-1", className)}>
      {type === "task" ? (
        <SimpleTooltip
          button={
            <TasksIcon className={cn("size-[1.125rem] text-blue-500", paused && "opacity-50")} />
          }
          content={`This queue was automatically created from your "${name}" task`}
        />
      ) : (
        <SimpleTooltip
          button={
            <RectangleStackIcon
              className={cn("size-[1.125rem] text-purple-500", paused && "opacity-50")}
            />
          }
          content={`This is a custom queue you added in your code.`}
        />
      )}
      <span className={paused ? "opacity-50" : undefined}>{name}</span>
    </span>
  );
}
