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
  /* The dot fills the container, so resizing the whole thing scales the dot and
     the ping ring together. */
  return (
    <span className={cn("relative flex size-2 items-center justify-center", className)}>
      <span
        className={cn(
          "absolute h-full w-full animate-ping rounded-full border border-blue-500 opacity-100 duration-1000",
          ringClassName
        )}
      />
      <span className={cn("size-full rounded-full bg-blue-500", dotClassName)} />
    </span>
  );
}
