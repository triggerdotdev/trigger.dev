import { cn } from "~/utils/cn";
import { formatCurrency } from "~/utils/numberFormatter";
import { Paragraph } from "../../primitives/Paragraph";
import { SimpleTooltip } from "../../primitives/Tooltip";
import { motion } from "framer-motion";

type UsageBarProps = {
  current: number;
  billingLimit?: number;
  tierLimit?: number;
  projectedUsage: number;
  isPaying: boolean;
};

export function UsageBar({
  current,
  billingLimit,
  tierLimit,
  projectedUsage,
  isPaying,
}: UsageBarProps) {
  const getLargestNumber = Math.max(
    current,
    tierLimit ?? -Infinity,
    projectedUsage,
    billingLimit ?? -Infinity,
    5
  );
  //creates a maximum range for the progress bar, add 10% to the largest number so the bar doesn't reach the end
  const maxRange = Math.round(getLargestNumber * 1.1);
  const tierRunLimitPercentage = tierLimit ? Math.round((tierLimit / maxRange) * 100) : 0;
  const projectedRunsPercentage = Math.round((projectedUsage / maxRange) * 100);
  const billingLimitPercentage =
    billingLimit !== undefined ? Math.round((billingLimit / maxRange) * 100) : 0;
  const usagePercentage = Math.round((current / maxRange) * 100);

  //cap the usagePercentage to the freeRunLimitPercentage
  const usageCappedToLimitPercentage = Math.min(usagePercentage, tierRunLimitPercentage);

  return (
    <div className="h-fit w-full py-12">
      <div className="relative h-3 w-full rounded-sm bg-background-bright">
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
              value={formatCurrency(billingLimit, false)}
              position="bottomRow2"
              percentage={billingLimitPercentage}
              tooltipContent={`Billing limit: ${formatCurrency(billingLimit, false)}`}
            />
          </motion.div>
        )}
        {tierLimit && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: tierRunLimitPercentage + "%" }}
            transition={{ duration: 1.5, type: "spring" }}
            style={{ width: `${tierRunLimitPercentage}%` }}
            className="absolute h-3 rounded-l-sm bg-green-900/50"
          >
            <Legend
              text={isPaying ? `Included usage:` : `Tier limit:`}
              value={formatCurrency(tierLimit, false)}
              position="bottomRow1"
              percentage={tierRunLimitPercentage}
              tooltipContent={`${isPaying ? "Included usage" : "Tier limit"}: ${formatCurrency(
                tierLimit,
                false
              )}`}
            />
          </motion.div>
        )}
        {projectedUsage !== 0 && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: projectedRunsPercentage + "%" }}
            transition={{ duration: 1.5, type: "spring" }}
            style={{ width: `${projectedRunsPercentage}%` }}
            className="absolute h-3 rounded-l-sm"
          >
            <Legend
              text="Projected:"
              value={formatCurrency(projectedUsage, false)}
              position="topRow2"
              percentage={projectedRunsPercentage}
              tooltipContent={`Projected runs: ${formatCurrency(projectedUsage, false)}`}
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
            tierLimit && current > tierLimit ? "bg-rose-600" : "bg-green-600"
          )}
        >
          <Legend
            text="Current:"
            value={formatCurrency(current, false)}
            position="topRow1"
            percentage={usagePercentage}
            tooltipContent={`Current usage: ${formatCurrency(current, false)}`}
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
        "absolute left-full z-10 flex border-charcoal-500",
        positions[position],
        flipLegendPosition === true ? "-translate-x-full border-r" : "border-l"
      )}
    >
      <SimpleTooltip
        button={
          <Paragraph className="mr-px h-fit whitespace-nowrap bg-background-bright px-1.5 text-xs text-text-bright">
            {text}
            <span className="ml-1 text-text-dimmed">{value}</span>
          </Paragraph>
        }
        side="top"
        content={tooltipContent}
        className="z-50 h-fit"
      />
    </div>
  );
}
