import { cn } from "~/utils/cn";

export function PulsingDot({
  className,
  ringClassName,
  dotClassName,
}: {
  className?: string;
  ringClassName?: string;
  dotClassName?: string;
}) {
  return (
    <span className={cn("relative flex size-2", className)}>
      <span
        className={cn(
          "absolute h-full w-full animate-ping rounded-full border border-blue-500 opacity-100 duration-1000",
          ringClassName
        )}
      />
      <span className={cn("size-2 rounded-full bg-blue-500", dotClassName)} />
    </span>
  );
}
