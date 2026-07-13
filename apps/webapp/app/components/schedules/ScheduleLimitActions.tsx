import { ArrowUpCircleIcon } from "@heroicons/react/20/solid";
import { Feedback } from "~/components/Feedback";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import { type MatchedOrganization } from "~/hooks/useOrganizations";
import { v3BillingPath } from "~/utils/pathBuilder";
import { PurchaseSchedulesModal, type SchedulePricing } from "./PurchaseSchedulesModal";

type Props = {
  actionPath: string;
  canPurchaseSchedules: boolean;
  schedulePricing: SchedulePricing | null;
  extraSchedules: number;
  limits: { used: number; limit: number };
  maxScheduleQuota: number;
  planScheduleLimit: number;
  canUpgrade: boolean;
  organization: MatchedOrganization;
  variant?: "dialog" | "banner";
};

export function ScheduleLimitActions({
  actionPath,
  canPurchaseSchedules,
  schedulePricing,
  extraSchedules,
  limits,
  maxScheduleQuota,
  planScheduleLimit,
  canUpgrade,
  organization,
  variant = "banner",
}: Props) {
  const showSelfServe = useShowSelfServe();

  if (!showSelfServe) {
    return (
      <Feedback
        button={<Button variant="secondary/small">Request more</Button>}
        defaultValue="enterprise"
      />
    );
  }

  if (canPurchaseSchedules && schedulePricing) {
    return (
      <PurchaseSchedulesModal
        actionPath={actionPath}
        schedulePricing={schedulePricing}
        extraSchedules={extraSchedules}
        usedSchedules={limits.used}
        maxQuota={maxScheduleQuota}
        planScheduleLimit={planScheduleLimit}
        triggerButton={
          variant === "dialog" ? <Button variant="primary/small">Purchase more…</Button> : undefined
        }
      />
    );
  }

  if (canUpgrade) {
    return variant === "dialog" ? (
      <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
        Upgrade
      </LinkButton>
    ) : (
      <LinkButton
        to={v3BillingPath(organization)}
        variant="secondary/small"
        LeadingIcon={ArrowUpCircleIcon}
        leadingIconClassName="text-indigo-500"
      >
        Upgrade
      </LinkButton>
    );
  }

  return (
    <Feedback button={<Button variant="primary/small">Request more</Button>} defaultValue="help" />
  );
}
