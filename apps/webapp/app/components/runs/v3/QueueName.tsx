import { TaskIconSmall } from "~/assets/icons/TaskIcon";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import { RectangleStackIcon } from "@heroicons/react/20/solid";

export function QueueName({
  name,
  type,
  paused,
  className,
}: {
  name: string;
  type: "task" | "custom";
  paused?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("flex items-center gap-1", className)}>
      {type === "task" ? (
        <SimpleTooltip
          button={
            <TaskIconSmall
              className={cn("size-[1.125rem] text-blue-500", paused && "opacity-50")}
            />
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
