import {
  CheckCircleIcon,
  ClockIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
  NoSymbolIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import type {
  WatchObservedOutcome,
  WatchResolution,
  WatchSemanticIcon,
  WatchStatus,
} from "@internal/dashboard-agent-contracts";
import { AgentSpinner } from "~/components/primitives/Spinner";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { cn } from "~/utils/cn";
import { type AgentTone, TONE_ICON_COLOR } from "./agent-badges";
import { wakePresentation } from "./WakeBanner";
import { watchChipLabel, watchChipTooltip } from "./watch-chips";

/** As the panel's loader hands it over: dates are already JSON strings. */
export type WatchChip = {
  id: string;
  identity: string;
  status: WatchStatus;
  kind: string;
  note: string;
  checkEveryMinutes: number;
  expiresAt: string;
  endedReason?: string | null;
  /** Null while active; absent on rows written before the resolution column. */
  resolution?: WatchResolution | null;
  observedOutcome?: WatchObservedOutcome | null;
};

const SEMANTIC_ICON: Record<WatchSemanticIcon, (props: { className?: string }) => JSX.Element> = {
  success: CheckCircleIcon,
  attention: ExclamationTriangleIcon,
  error: ExclamationCircleIcon,
  waiting: ClockIcon,
  info: InformationCircleIcon,
};

/**
 * A terminal chip wears the resolved result's icon, not its lifecycle status: a
 * `run_finished` watch on a failed run resolves `condition_met`. Cancellation has none.
 */
function StatusIcon({ watch }: { watch: WatchChip }) {
  if (watch.status === "active") return <AgentSpinner size={14} />;

  if (watch.status === "cancelled") {
    return <NoSymbolIcon className={cn("size-3.5 shrink-0", TONE_ICON_COLOR.neutral as string)} />;
  }

  const presentation = wakePresentation(watch.status === "fired" ? "fired" : "expired", watch);
  const Icon = SEMANTIC_ICON[presentation.semanticIcon];
  return (
    <Icon className={cn("size-3.5 shrink-0", TONE_ICON_COLOR[presentation.tone as AgentTone])} />
  );
}

export function WatchChips({
  watches,
  onCancel,
}: {
  watches: WatchChip[];
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
            // No native `title`: it would stack with the custom tooltip.
            className="inline-flex items-center gap-1.5 rounded-full border border-border-bright bg-background-bright py-0.5 pl-2 pr-1.5 text-xs text-text-bright"
          >
            <StatusIcon watch={watch} />
            <SimpleTooltip
              // Status, cadence and expiry live only here, so it needs a tab stop.
              tabbable
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
