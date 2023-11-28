import { cn } from "~/utils/cn";
import { Paragraph } from "../primitives/Paragraph";

type UsageBarProps = {
  numberOfCurrentRuns: number;
  billingLimit?: number | undefined;
  tierRunLimit: number;
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
  //create a maximum range for the progress bar
  const getLargestNumber = Math.max(
    numberOfCurrentRuns,
    tierRunLimit,
    projectedRuns,
    billingLimit ?? -Infinity
  );
  const maxRange = Math.round(getLargestNumber * 1.15);

  //convert the freeRunLimit into a percentage
  const tierRunLimitPercentage = Math.round((tierRunLimit / maxRange) * 100);

  //convert the projectedRuns into a percentage
  const projectedRunsPercentage = Math.round((projectedRuns / maxRange) * 100);

  //convert the BillingLimit into a percentage
  const billingLimitPercentage =
    billingLimit !== undefined ? Math.round((billingLimit / maxRange) * 100) : 0;

  const usagePercentage = Math.round((numberOfCurrentRuns / maxRange) * 100);

  const usageCappedToLimitPercentage = Math.min(usagePercentage, tierRunLimitPercentage);
  return (
    <div className="h-fit w-full py-16">
      <div className="relative h-3 w-full rounded-sm bg-slate-800">
        {billingLimit && (
          <div
            style={{ width: `${billingLimitPercentage}%` }}
            className="absolute h-3 rounded-l-sm"
          >
            <Legend
              text="Billing limit:"
              value={billingLimit}
              position="bottomRow2"
              percentage={billingLimitPercentage}
            />
          </div>
        )}
        <div
          style={{ width: `${tierRunLimitPercentage}%` }}
          className="absolute h-3 rounded-l-sm bg-green-900/50"
        >
          <Legend
            text={`${subscribedToPaidTier ? "Included free:" : "Free tier limit:"}`}
            value={tierRunLimit}
            position="bottomRow1"
            percentage={tierRunLimitPercentage}
          />
        </div>
        <div style={{ width: `${projectedRunsPercentage}%` }} className="absolute h-3 rounded-l-sm">
          <Legend
            text="Projected:"
            value={projectedRuns}
            position="topRow2"
            percentage={projectedRunsPercentage}
          />
        </div>

        <div
          style={{ width: `${usagePercentage}%` }}
          className={cn(
            "absolute h-3 rounded-l-sm",
            subscribedToPaidTier ? "bg-green-600" : "bg-rose-600"
          )}
        >
          <Legend
            text="Current:"
            value={numberOfCurrentRuns}
            position="topRow1"
            percentage={usagePercentage}
          />
        </div>
        <div
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
  value: number;
  percentage: number;
  position: keyof typeof positions;
};

function Legend({ text, value, position, percentage }: LegendProps) {
  const flipLegendPositionValue = 80;
  const flipLegendPosition = percentage > flipLegendPositionValue ? true : false;
  return (
    <div
      className={cn(
        "absolute left-full z-10 flex border-slate-400",
        positions[position],
        flipLegendPosition === true ? "-translate-x-full border-r" : "border-l"
      )}
    >
      <Paragraph className="mr-px h-fit whitespace-nowrap bg-background px-1.5 text-xs text-dimmed">
        {text}
        <span className="ml-1 text-bright">{value}</span>
      </Paragraph>
    </div>
  );
}
