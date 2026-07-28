/**
 * The watch chip row. One chip per watch, its state carried by a coloured icon,
 * with a cancel affordance on the active ones only.
 *
 * A chip has to answer "what is being watched, and is it still watching?" at a
 * glance in a 380px panel — hence the short label plus a state icon, with the
 * note and cadence in a tooltip rather than on screen. The label text keeps the
 * default colour: only the icon is coloured, the same rule the run status cells
 * follow.
 */
import { CheckCircleIcon, ClockIcon, NoSymbolIcon, XMarkIcon } from "@heroicons/react/20/solid";
import type { WatchStatus } from "@internal/dashboard-agent-contracts";
import { Spinner } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import { type AgentTone, TONE_ICON_COLOR } from "./agent-badges";
import { watchChipLabel, watchChipTooltip } from "./watch-chips";

/** One watch, as the panel's loader hands it over (dates already JSON strings). */
export type WatchChip = {
  id: string;
  identity: string;
  status: WatchStatus;
  kind: string;
  note: string;
  checkEveryMinutes: number;
  expiresAt: string;
};

const STATUS_TONE: Record<WatchStatus, AgentTone> = {
  active: "neutral",
  fired: "success",
  expired: "neutral",
  cancelled: "neutral",
};

function StatusIcon({ status }: { status: WatchStatus }) {
  const className = cn("size-3.5 shrink-0", TONE_ICON_COLOR[STATUS_TONE[status]]);
  switch (status) {
    case "active":
      // Same choice as an executing run: a spinner is the "still going" state.
      return <Spinner className="size-3.5 shrink-0" />;
    case "fired":
      return <CheckCircleIcon className={className} />;
    case "expired":
      return <ClockIcon className={className} />;
    case "cancelled":
      return <NoSymbolIcon className={className} />;
  }
}

export function WatchChips({
  watches,
  onCancel,
}: {
  watches: WatchChip[];
  /** Stop watching. Only offered on an active watch. */
  onCancel?: (watchId: string) => void;
}) {
  if (watches.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2">
      <span className="text-[10px] uppercase tracking-wide text-text-faint">watches</span>
      {watches.map((watch) => {
        const label = watchChipLabel(watch);
        return (
          <span
            key={watch.id}
            // No native `title` on the chip: it would stack with the custom
            // tooltip when hovering the ×. The note/cadence tooltip lives on the
            // label instead.
            className="inline-flex items-center gap-1.5 rounded-full border border-border-bright bg-background-bright py-0.5 pl-2 pr-1.5 text-xs text-text-bright"
          >
            <StatusIcon status={watch.status} />
            <SimpleTooltip
              side="bottom"
              content={watchChipTooltip(watch)}
              button={<span className="max-w-[12rem] truncate">{label}</span>}
            />
            {watch.status === "active" && onCancel ? (
              <SimpleTooltip
                asChild
                tabbable
                side="bottom"
                content={`Cancel the ${label} watch`}
                button={
                  <button
                    type="button"
                    // Icon-only, so the label has to name the watch it cancels.
                    aria-label={`Cancel the ${label} watch`}
                    onClick={() => onCancel(watch.id)}
                    className="text-text-faint transition-colors hover:text-error focus-visible:text-error focus-custom"
                  >
                    <XMarkIcon className="size-3.5" />
                  </button>
                }
              />
            ) : null}
          </span>
        );
      })}
    </div>
  );
}
