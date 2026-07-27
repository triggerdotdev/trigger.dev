/**
 * The watch chip row. One chip per watch, its state carried by colour, with a
 * cancel affordance on the active ones only.
 *
 * A chip has to answer "what is being watched, and is it still watching?" at a
 * glance in a 380px panel — hence the short label plus a state dot, with the
 * note and cadence in the title attribute rather than on screen.
 */
import { XMarkIcon } from "@heroicons/react/20/solid";
import type { WatchStatus } from "@internal/dashboard-agent-contracts";
import { cn } from "~/utils/cn";
import type { DemoWatch } from "../fixtures/watches";

const STATUS_STYLES: Record<WatchStatus, string> = {
  active: "border-indigo-500/40 text-indigo-300",
  fired: "border-emerald-500/40 text-emerald-400",
  expired: "border-border-bright text-text-dimmed",
  cancelled: "border-border-bright text-text-faint line-through",
};

const STATUS_DOT: Record<WatchStatus, string> = {
  active: "bg-indigo-400 animate-pulse",
  fired: "bg-emerald-500",
  expired: "bg-text-dimmed",
  cancelled: "bg-text-faint",
};

const STATUS_LABEL: Record<WatchStatus, string> = {
  active: "watching",
  fired: "fired",
  expired: "expired",
  cancelled: "cancelled",
};

export function DemoWatchChips({
  watches,
  onCancel,
}: {
  watches: DemoWatch[];
  /** Demo interceptor. Never cancels anything — reports what would happen. */
  onCancel?: (watch: DemoWatch) => void;
}) {
  if (watches.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[10px] uppercase tracking-wide text-text-faint">watches</span>
      {watches.map((watch) => (
        <span
          key={watch.id}
          title={`${watch.spec.note} · every ${watch.spec.checkEveryMinutes} min · ${STATUS_LABEL[watch.status]}`}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border bg-background-bright px-2 py-0.5 text-xs",
            STATUS_STYLES[watch.status]
          )}
        >
          <span className={cn("size-1.5 rounded-full", STATUS_DOT[watch.status])} aria-hidden />
          {watch.chipLabel}
          {watch.cancellable ? (
            <button
              type="button"
              aria-label={`Stop watching ${watch.chipLabel}`}
              onClick={() => onCancel?.(watch)}
              className="-mr-0.5 rounded-full p-0.5 text-text-dimmed transition-colors hover:text-text-bright"
            >
              <XMarkIcon className="size-3" />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}
