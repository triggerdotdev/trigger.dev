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
  /* The dot fills the container rather than carrying its own size, so a call
     site that resizes the whole thing (`className="size-3"`) scales the dot and
     the ping ring together. It used to be a fixed size-2 next to a full-width
     ring, so any other size left a small dot sitting in the corner of an
     oversized halo - flex-start in both axes, since nothing centered it. */
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
