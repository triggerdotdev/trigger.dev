import { ArrowUpCircleIcon } from "@heroicons/react/20/solid";
import { Feedback } from "~/components/Feedback";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { InfoIconTooltip, SimpleTooltip } from "~/components/primitives/Tooltip";
import { useOrganization } from "~/hooks/useOrganizations";
import { v3BillingPath, v3SchedulesAddOnPath } from "~/utils/pathBuilder";
import {
  PurchaseSchedulesModal,
  type SchedulePricing,
} from "./PurchaseSchedulesModal";

type Props = {
  limits: { used: number; limit: number };
  /** True when the user has used all available schedules and cannot exceed the plan limit. */
  requiresUpgrade: boolean;
  /** True when the plan would let them upgrade (vs being already on the highest plan). */
  canUpgrade: boolean;
  canPurchaseSchedules: boolean;
  extraSchedules: number;
  maxScheduleQuota: number;
  planScheduleLimit: number;
  schedulePricing: SchedulePricing | null;
};

export function SchedulesUsageBar({
  limits,
  requiresUpgrade,
  canUpgrade,
  canPurchaseSchedules,
  extraSchedules,
  maxScheduleQuota,
  planScheduleLimit,
  schedulePricing,
}: Props) {
  const organization = useOrganization();
  const actionPath = v3SchedulesAddOnPath(organization);
  const ratio = limits.limit > 0 ? Math.min(limits.used / limits.limit, 1) : 0;

  return (
    <div className="flex w-full items-start justify-between">
      <div className="flex h-fit w-full items-center gap-4 border-t border-grid-bright bg-background-bright p-[0.86rem] pl-4">
        <SimpleTooltip
          button={
            <div className="size-6">
              <svg className="h-full w-full -rotate-90 overflow-visible">
                <circle
                  className="fill-none stroke-grid-bright"
                  strokeWidth="4"
                  r="10"
                  cx="12"
                  cy="12"
                />
                <circle
                  className={`fill-none ${requiresUpgrade ? "stroke-error" : "stroke-success"}`}
                  strokeWidth="4"
                  r="10"
                  cx="12"
                  cy="12"
                  strokeDasharray={`${ratio * 62.8} 62.8`}
                  strokeDashoffset="0"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          }
          content={`${Math.round(ratio * 100)}%`}
        />
        <div className="flex w-full items-center justify-between gap-6">
          {requiresUpgrade ? (
            <Header3 className="text-error">
              You've used all {limits.limit} of your available schedules. Upgrade your plan to
              enable more.
            </Header3>
          ) : (
            <div className="flex items-center gap-1">
              <Header3>
                You've used {limits.used}/{limits.limit} of your schedules
              </Header3>
              <InfoIconTooltip content="Schedules created in Dev don't count towards your limit." />
            </div>
          )}

          {canPurchaseSchedules && schedulePricing ? (
            <PurchaseSchedulesModal
              actionPath={actionPath}
              schedulePricing={schedulePricing}
              extraSchedules={extraSchedules}
              usedSchedules={limits.used}
              maxQuota={maxScheduleQuota}
              planScheduleLimit={planScheduleLimit}
            />
          ) : canUpgrade ? (
            <LinkButton
              to={v3BillingPath(organization)}
              variant="secondary/small"
              LeadingIcon={ArrowUpCircleIcon}
              leadingIconClassName="text-indigo-500"
            >
              Upgrade
            </LinkButton>
          ) : (
            <Feedback
              button={<Button variant="secondary/small">Request more</Button>}
              defaultValue="help"
            />
          )}
        </div>
      </div>
    </div>
  );
}
