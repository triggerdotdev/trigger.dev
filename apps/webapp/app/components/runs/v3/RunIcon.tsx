import {
  ClockIcon,
  HandRaisedIcon,
  InformationCircleIcon,
  RectangleStackIcon,
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
import { RunFunctionIcon } from "~/assets/icons/RunFunctionIcon";
import { MiddlewareIcon } from "~/assets/icons/MiddlewareIcon";
import { FunctionIcon } from "~/assets/icons/FunctionIcon";
import { TriggerIcon } from "~/assets/icons/TriggerIcon";
import { PythonLogoIcon } from "~/assets/icons/PythonLogoIcon";
import { TraceIcon } from "~/assets/icons/TraceIcon";
import { WaitpointTokenIcon } from "~/assets/icons/WaitpointTokenIcon";
import { StreamsIcon } from "~/assets/icons/StreamsIcon";

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
  if (tablerIcons.has(name)) {
    return <TablerIcon name={name} className={className} />;
  }

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
      return <TraceIcon className={cn(className, "text-text-dimmed")} />;
    case "tag":
      return <TagIcon className={cn(className, "text-text-dimmed")} />;
    case "queue":
      return <RectangleStackIcon className={cn(className, "text-purple-500")} />;
    case "trigger":
      return <TriggerIcon className={cn(className, "text-orange-500")} />;
    case "python":
      return <PythonLogoIcon className={className} />;
    case "wait-token":
      return <WaitpointTokenIcon className={cn(className, "text-sky-500")} />;
    case "function":
      return <FunctionIcon className={cn(className, "text-text-dimmed")} />;
    //log levels
    case "debug":
    case "log":
    case "info":
      return <InformationCircleIcon className={cn(className, "text-text-dimmed")} />;
    case "warn":
      return <InformationCircleIcon className={cn(className, "text-amber-400")} />;
    case "error":
      return <InformationCircleIcon className={cn(className, "text-error")} />;
    case "fatal":
      return <HandRaisedIcon className={cn(className, "text-error")} />;
    case "task-middleware":
      return <MiddlewareIcon className={cn(className, "text-text-dimmed")} />;
    case "task-fn-run":
      return <RunFunctionIcon className={cn(className, "text-text-dimmed")} />;
    case "task-hook-init":
    case "task-hook-onStart":
    case "task-hook-onSuccess":
    case "task-hook-onWait":
    case "task-hook-onResume":
    case "task-hook-onComplete":
    case "task-hook-cleanup":
    case "task-hook-onCancel":
      return <FunctionIcon className={cn(className, "text-text-dimmed")} />;
    case "task-hook-onFailure":
    case "task-hook-catchError":
      return <FunctionIcon className={cn(className, "text-error")} />;
    case "streams":
        return <StreamsIcon className={cn(className, "text-text-dimmed")} />;
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
