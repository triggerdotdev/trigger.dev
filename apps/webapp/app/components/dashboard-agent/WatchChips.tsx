/**
 * The watch chip row. One chip per watch, its state carried by a coloured icon,
 * with cancel offered on active watches only. The note and cadence live in a
 * tooltip because the chip has to fit a 380px panel.
 */
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

/** One watch, as the panel's loader hands it over (dates already JSON strings). */
export type WatchChip = {
  id: string;
  identity: string;
  status: WatchStatus;
  kind: string;
  note: string;
  checkEveryMinutes: number;
  expiresAt: string;
  /** Last check's reason. The wake banner distinguishes terminal_unsatisfied. */
  endedReason?: string | null;
  /** How the watch ended. Null while active; absent on pre-resolution rows. */
  resolution?: WatchResolution | null;
  /** What the resolving check observed. The other half of the terminal icon. */
  observedOutcome?: WatchObservedOutcome | null;
};

/**
 * Semantic icon to glyph. Which icon a resolved result gets is decided in
 * contracts; this only owns the glyph set.
 */
const SEMANTIC_ICON: Record<WatchSemanticIcon, (props: { className?: string }) => JSX.Element> = {
  success: CheckCircleIcon,
  attention: ExclamationTriangleIcon,
  error: ExclamationCircleIcon,
  waiting: ClockIcon,
  info: InformationCircleIcon,
};

/**
 * A terminal chip wears the resolved result's icon, not its lifecycle status: a
 * `run_finished` watch on a run that failed resolves `condition_met` and would
 * otherwise show a green check. The chip and the wake banner render the same
 * presentation so they agree by construction. Cancellation is the exception: it
 * has no resolution, so it keeps its own glyph.
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
            // tooltip when hovering the cancel button.
            className="inline-flex items-center gap-1.5 rounded-full border border-border-bright bg-background-bright py-0.5 pl-2 pr-1.5 text-xs text-text-bright"
          >
            <StatusIcon watch={watch} />
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
