import { CheckCircleIcon, ClockIcon, NoSymbolIcon, XMarkIcon } from "@heroicons/react/20/solid";
import type { WatchStatus } from "@internal/dashboard-agent-contracts";
import { AgentSpinner } from "~/components/primitives/Spinner";
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
      return <AgentSpinner size={14} />;
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
  onCancel?: (watch: DemoWatch) => void;
}) {
  if (watches.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[10px] uppercase tracking-wide text-text-faint">watches</span>
      {watches.map((watch) => (
        <span
          key={watch.id}
          // No native `title` here: it would stack with the custom tooltip on the ×.
          className="inline-flex items-center gap-1.5 rounded-full border border-border-bright bg-background-bright py-0.5 pl-2 pr-1.5 text-xs text-text-bright"
        >
          <StatusIcon status={watch.status} />
          <SimpleTooltip
            side="bottom"
            content={`${watch.spec.note} · every ${watch.spec.checkEveryMinutes} min · ${STATUS_LABEL[watch.status]}`}
            button={<span>{watch.chipLabel}</span>}
          />
          {watch.cancellable ? (
            <SimpleTooltip
              asChild
              tabbable
              side="bottom"
              content={`Cancel the ${watch.chipLabel} watch`}
              button={
                <button
                  type="button"
                  aria-label={`Cancel the ${watch.chipLabel} watch`}
                  onClick={() => onCancel?.(watch)}
                  className="text-text-faint transition-colors hover:text-error focus-visible:text-error focus-custom"
                >
                  <XMarkIcon className="size-3.5" />
                </button>
              }
            />
          ) : null}
        </span>
      ))}
    </div>
  );
}
