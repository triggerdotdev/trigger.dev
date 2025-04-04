import { WarmStartIcon } from "~/assets/icons/WarmStartIcon";
import { InfoIconTooltip, SimpleTooltip } from "./primitives/Tooltip";
import { cn } from "~/utils/cn";
import { Paragraph } from "./primitives/Paragraph";

export function WarmStartCombo({
  isWarmStart,
  showTooltip = false,
  className,
}: {
  isWarmStart: boolean;
  showTooltip?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-1 text-sm text-text-dimmed", className)}>
      <WarmStartIcon isWarmStart={isWarmStart} className="size-5" />
      <span>{isWarmStart ? "Warm Start" : "Cold Start"}</span>
      {showTooltip && <InfoIconTooltip content={<WarmStartTooltipContent />} />}
    </div>
  );
}

export function WarmStartIconWithTooltip({
  isWarmStart,
  className,
}: {
  isWarmStart: boolean;
  className?: string;
}) {
  return (
    <SimpleTooltip
      className="relative z-[9999]"
      button={<WarmStartIcon isWarmStart={isWarmStart} className={className} />}
      content={<WarmStartTooltipContent />}
    />
  );
}

function WarmStartTooltipContent() {
  return (
    <div className="flex max-w-xs flex-col gap-4 p-1">
      <div>
        <WarmStartCombo isWarmStart={false} className="mb-0.5 text-text-bright" />
        <Paragraph variant="small" className="!text-wrap text-text-dimmed">
          A cold start happens when we need to boot up a new machine for your run to execute. This
          takes longer than a warm start.
        </Paragraph>
      </div>
      <div>
        <WarmStartCombo isWarmStart={true} className="mb-0.5 text-text-bright" />
        <Paragraph variant="small" className="!text-wrap text-text-dimmed">
          A warm start happens when we can reuse a machine from a run that recently finished. This
          takes less time than a cold start.
        </Paragraph>
      </div>
    </div>
  );
}
