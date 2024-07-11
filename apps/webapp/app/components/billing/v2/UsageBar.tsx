import { cn } from "~/utils/cn";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { Paragraph } from "../../primitives/Paragraph";
import { SimpleTooltip } from "../../primitives/Tooltip";
import { motion } from "framer-motion";

type UsageBarProps = {
  numberOfCurrentRuns: number;
  billingLimit?: number;
  tierRunLimit?: number;
  projectedRuns: number;
  subscribedToPaidTier?: boolean;
};

export function UsageBar({
  numberOfCurrentRuns,
  billingLimit,
  tierRunLimit,
  projectedRuns,
  subscribedToPaidTier = false,
}: UsageBarProps) {
  const getLargestNumber = Math.max(
    numberOfCurrentRuns,
    tierRunLimit ?? -Infinity,
    projectedRuns,
    billingLimit ?? -Infinity
  );
  //creates a maximum range for the progress bar, add 10% to the largest number so the bar doesn't reach the end
  const maxRange = Math.round(getLargestNumber * 1.1);
  const tierRunLimitPercentage = tierRunLimit ? Math.round((tierRunLimit / maxRange) * 100) : 0;
  const projectedRunsPercentage = Math.round((projectedRuns / maxRange) * 100);
  const billingLimitPercentage =
    billingLimit !== undefined ? Math.round((billingLimit / maxRange) * 100) : 0;
  const usagePercentage = Math.round((numberOfCurrentRuns / maxRange) * 100);

  //cap the usagePercentage to the freeRunLimitPercentage
  const usageCappedToLimitPercentage = Math.min(usagePercentage, tierRunLimitPercentage);

  return (
    <div className="h-fit w-full py-16">
      <div className="relative h-3 w-full rounded-sm bg-charcoal-800">
        {billingLimit && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: billingLimitPercentage + "%" }}
            transition={{ duration: 1.5, type: "spring" }}
            style={{ width: `${billingLimitPercentage}%` }}
            className="absolute h-3 rounded-l-sm"
          >
            <Legend
              text="Billing limit:"
              value={formatNumberCompact(billingLimit)}
              position="bottomRow2"
              percentage={billingLimitPercentage}
              tooltipContent={`Billing limit: ${formatNumberCompact(billingLimit)}`}
            />
          </motion.div>
        )}
        {tierRunLimit && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: tierRunLimitPercentage + "%" }}
            transition={{ duration: 1.5, type: "spring" }}
            style={{ width: `${tierRunLimitPercentage}%` }}
            className="absolute h-3 rounded-l-sm bg-green-900/50"
          >
            <Legend
              text={`${subscribedToPaidTier ? "Included free:" : "Free tier limit:"}`}
              value={formatNumberCompact(tierRunLimit)}
              position="bottomRow1"
              percentage={tierRunLimitPercentage}
              tooltipContent={`${
                subscribedToPaidTier
                  ? `Runs included free: ${formatNumberCompact(tierRunLimit)}`
                  : `Free tier runs limit: ${formatNumberCompact(tierRunLimit)}`
              }`}
            />
          </motion.div>
        )}
        {projectedRuns !== 0 && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: projectedRunsPercentage + "%" }}
            transition={{ duration: 1.5, type: "spring" }}
            style={{ width: `${projectedRunsPercentage}%` }}
            className="absolute h-3 rounded-l-sm"
          >
            <Legend
              text="Projected:"
              value={formatNumberCompact(projectedRuns)}
              position="topRow2"
              percentage={projectedRunsPercentage}
              tooltipContent={`Projected runs: ${formatNumberCompact(projectedRuns)}`}
            />
          </motion.div>
        )}
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: usagePercentage + "%" }}
          transition={{ duration: 1.5, type: "spring" }}
          style={{ width: `${usagePercentage}%` }}
          className={cn(
            "absolute h-3 rounded-l-sm",
            subscribedToPaidTier ? "bg-green-600" : "bg-rose-600"
          )}
        >
          <Legend
            text="Current:"
            value={formatNumberCompact(numberOfCurrentRuns)}
            position="topRow1"
            percentage={usagePercentage}
            tooltipContent={`Current run count: ${formatNumberCompact(numberOfCurrentRuns)}`}
          />
        </motion.div>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: usageCappedToLimitPercentage + "%" }}
          transition={{ duration: 1.5, type: "spring" }}
          style={{ width: `${usageCappedToLimitPercentage}%` }}
          className="absolute h-3 rounded-l-sm bg-green-600"
        />
      </div>
    </div>
  );
}

const positions = {
  topRow1: "bottom-0 h-9",
  topRow2: "bottom-0 h-14",
  bottomRow1: "top-0 h-9 items-end",
  bottomRow2: "top-0 h-14 items-end",
};

type LegendProps = {
  text: string;
  value: number | string;
  percentage: number;
  position: keyof typeof positions;
  tooltipContent: string;
};

function Legend({ text, value, position, percentage, tooltipContent }: LegendProps) {
  const flipLegendPositionValue = 80;
  const flipLegendPosition = percentage > flipLegendPositionValue ? true : false;
  return (
    <div
      className={cn(
        "absolute left-full z-10 flex border-charcoal-400",
        positions[position],
        flipLegendPosition === true ? "-translate-x-full border-r" : "border-l"
      )}
    >
      <SimpleTooltip
        button={
          <Paragraph className="mr-px h-fit whitespace-nowrap bg-background-dimmed px-1.5 text-xs text-text-dimmed">
            {text}
            <span className="ml-1 text-text-bright">{value}</span>
          </Paragraph>
        }
        variant="dark"
        side="top"
        content={tooltipContent}
        className="z-50 h-fit"
      />
    </div>
  );
}
