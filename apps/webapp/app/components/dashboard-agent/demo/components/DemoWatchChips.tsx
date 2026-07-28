/**
 * The watch chip row. One chip per watch, its state carried by a coloured icon,
 * with a cancel affordance on the active ones only.
 *
 * A chip has to answer "what is being watched, and is it still watching?" at a
 * glance in a 380px panel — hence the short label plus a state icon, with the
 * note and cadence in the title attribute rather than on screen. The label text
 * keeps the default colour: only the icon is coloured, the same rule the run
 * status cells follow.
 */
import { CheckCircleIcon, ClockIcon, NoSymbolIcon, XMarkIcon } from "@heroicons/react/20/solid";
import type { WatchStatus } from "@internal/dashboard-agent-contracts";
import { Button } from "~/components/primitives/Buttons";
import { Spinner } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import { type AgentTone, TONE_ICON_COLOR } from "../../agent-badges";
import type { DemoWatch } from "../fixtures/watches";

const STATUS_TONE: Record<WatchStatus, AgentTone> = {
  active: "neutral",
  fired: "success",
  expired: "neutral",
  cancelled: "neutral",
};

const STATUS_LABEL: Record<WatchStatus, string> = {
  active: "watching",
  fired: "fired",
  expired: "expired",
  cancelled: "cancelled",
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
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide text-text-faint">watches</span>
      {watches.map((watch) => (
        <span
          key={watch.id}
          title={`${watch.spec.note} · every ${watch.spec.checkEveryMinutes} min · ${STATUS_LABEL[watch.status]}`}
          className="inline-flex items-center gap-2 rounded-full border border-border-bright bg-background-bright py-0.5 pl-2 pr-1 text-xs text-text-bright"
        >
          <StatusIcon status={watch.status} />
          {watch.chipLabel}
          {watch.cancellable ? (
            <SimpleTooltip
              asChild
              tabbable
              side="bottom"
              content={`Cancel the ${watch.chipLabel} watch`}
              button={
                <Button
                  variant="danger/small"
                  LeadingIcon={XMarkIcon}
                  className="h-5 rounded-full px-1.5"
                  // Icon-only, so the label has to name the watch it cancels.
                  aria-label={`Cancel the ${watch.chipLabel} watch`}
                  onClick={() => onCancel?.(watch)}
                />
              }
            />
          ) : null}
        </span>
      ))}
    </div>
  );
}
