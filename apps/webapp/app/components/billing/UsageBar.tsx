import { cn } from "~/utils/cn";
import { formatCurrency } from "~/utils/numberFormatter";
import { Paragraph } from "../primitives/Paragraph";
import { SimpleTooltip } from "../primitives/Tooltip";
import { motion } from "framer-motion";

type UsageBarProps = {
  current: number;
  billingLimit?: number;
  tierLimit?: number;
  isPaying: boolean;
};

const startFactor = 4;

export function UsageBar({ current, billingLimit, tierLimit, isPaying }: UsageBarProps) {
  const getLargestNumber = Math.max(current, tierLimit ?? -Infinity, billingLimit ?? -Infinity, 5);
  //creates a maximum range for the progress bar, add 10% to the largest number so the bar doesn't reach the end
  const maxRange = Math.round(getLargestNumber * 1.1);
  const tierRunLimitPercentage = tierLimit ? Math.round((tierLimit / maxRange) * 100) : 0;
  const billingLimitPercentage =
    billingLimit !== undefined ? Math.round((billingLimit / maxRange) * 100) : 0;
  const usagePercentage = Math.round((current / maxRange) * 100);

  //cap the usagePercentage to the freeRunLimitPercentage
  const usageCappedToLimitPercentage = Math.min(usagePercentage, tierRunLimitPercentage);

  return (
    <div className="h-fit w-full py-6">
      <div className="relative h-3 w-full rounded-sm bg-background-bright">
        {billingLimit !== undefined && (
          <motion.div
            initial={{ width: billingLimitPercentage / startFactor + "%" }}
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
            />
          </motion.div>
        )}
        <motion.div
          initial={{ width: usagePercentage / startFactor + "%" }}
          animate={{ width: usagePercentage + "%" }}
          transition={{ duration: 1.5, type: "spring" }}
          style={{ width: `${usagePercentage}%` }}
          className={cn(
            "absolute h-3 rounded-l-sm",
            tierLimit && current > tierLimit ? "bg-green-700" : "bg-green-600"
          )}
        >
          <Legend
            text="Used:"
            value={formatCurrency(current, false)}
            position="topRow1"
            percentage={usagePercentage}
          />
        </motion.div>
        {tierLimit !== undefined && (
          <motion.div
            initial={{ width: tierRunLimitPercentage / startFactor + "%" }}
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
            />
          </motion.div>
        )}
        <motion.div
          initial={{ width: usageCappedToLimitPercentage / startFactor + "%" }}
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
  tooltipContent?: string;
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
      {tooltipContent ? (
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
      ) : (
        <Paragraph className="mr-px h-fit whitespace-nowrap bg-background-bright px-1.5 text-xs text-text-bright">
          {text}
          <span className="ml-1 text-text-dimmed">{value}</span>
        </Paragraph>
      )}
    </div>
  );
}
