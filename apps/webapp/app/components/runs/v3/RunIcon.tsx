import {
  ClockIcon,
  HandRaisedIcon,
  InformationCircleIcon,
  Squares2X2Icon,
  TagIcon,
} from "@heroicons/react/20/solid";
import { AttemptIcon } from "~/assets/icons/AttemptIcon";
import { TaskIcon } from "~/assets/icons/TaskIcon";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { cn } from "~/utils/cn";

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
    return (
      <NamedIcon
        name={spanNameIcon.iconName}
        className={cn(className)}
        fallback={<InformationCircleIcon className={cn(className, "text-text-dimmed")} />}
      />
    );
  }

  if (!name) return <Squares2X2Icon className={cn(className, "text-text-dimmed")} />;

  switch (name) {
    case "task":
      return <TaskIcon className={cn(className, "text-blue-500")} />;
    case "scheduled":
      return <ClockIcon className={cn(className, "text-sun-500")} />;
    case "attempt":
      return <AttemptIcon className={cn(className, "text-text-dimmed")} />;
    case "wait":
      return <ClockIcon className={cn(className, "text-teal-500")} />;
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

  return (
    <NamedIcon
      name={name}
      className={cn(className)}
      fallback={<InformationCircleIcon className={cn(className, "text-text-dimmed")} />}
    />
  );
}
