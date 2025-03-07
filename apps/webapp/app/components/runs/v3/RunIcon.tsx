import {
  ClockIcon,
  HandRaisedIcon,
  InformationCircleIcon,
  Squares2X2Icon,
  TagIcon,
} from "@heroicons/react/20/solid";
import { AttemptIcon } from "~/assets/icons/AttemptIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { cn } from "~/utils/cn";
import { tablerIcons } from "~/utils/tablerIcons";
import tablerSpritePath from "~/components/primitives/tabler-sprite.svg";
import { TaskCachedIcon } from "~/assets/icons/TaskCachedIcon";
import { PauseIcon } from "~/assets/icons/PauseIcon";

type TaskIconProps = {
  name: string | undefined;
  spanName: string;
  className?: string;
};

type SpanNameIcons = {
  matcher: RegExp;
  iconName: string;
};

const spanNameIcons: SpanNameIcons[] = [{ matcher: /^prisma:/, iconName: "brand-prisma" }];

export function RunIcon({ name, className, spanName }: TaskIconProps) {
  const spanNameIcon = spanNameIcons.find(({ matcher }) => matcher.test(spanName));

  if (spanNameIcon) {
    if (tablerIcons.has("tabler-" + spanNameIcon.iconName)) {
      return <TablerIcon name={"tabler-" + spanNameIcon.iconName} className={className} />;
    } else if (
      spanNameIcon.iconName.startsWith("tabler-") &&
      tablerIcons.has(spanNameIcon.iconName)
    ) {
      return <TablerIcon name={spanNameIcon.iconName} className={className} />;
    }

    <InformationCircleIcon className={cn(className, "text-text-dimmed")} />;
  }

  if (!name) return <Squares2X2Icon className={cn(className, "text-text-dimmed")} />;

  switch (name) {
    case "task":
      return <TaskIcon className={cn(className, "text-blue-500")} />;
    case "task-cached":
      return <TaskCachedIcon className={cn(className, "text-blue-500")} />;
    case "scheduled":
      return <ClockIcon className={cn(className, "text-sun-500")} />;
    case "attempt":
      return <AttemptIcon className={cn(className, "text-text-dimmed")} />;
    case "wait":
      return <PauseIcon className={cn(className, "text-teal-500")} />;
    case "trace":
      return <Squares2X2Icon className={cn(className, "text-text-dimmed")} />;
    case "tag":
      return <TagIcon className={cn(className, "text-text-dimmed")} />;
    //log levels
    case "debug":
    case "log":
    case "info":
      return <InformationCircleIcon className={cn(className, "text-text-dimmed")} />;
    case "warn":
      return <InformationCircleIcon className={cn(className, "text-amber-400")} />;
    case "error":
      return <InformationCircleIcon className={cn(className, "text-rose-500")} />;
    case "fatal":
      return <HandRaisedIcon className={cn(className, "text-rose-800")} />;
  }

  return <InformationCircleIcon className={cn(className, "text-text-dimmed")} />;
}

function TablerIcon({ name, className }: { name: string; className?: string }) {
  return (
    <svg className={cn("stroke-[1.5]", className)}>
      <use xlinkHref={`${tablerSpritePath}#${name}`} />
    </svg>
  );
}
