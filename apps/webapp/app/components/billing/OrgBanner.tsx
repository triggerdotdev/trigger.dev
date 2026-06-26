import { useLocation } from "@remix-run/react";
import { DateTime } from "~/components/primitives/DateTime";
import { environmentFullTitle } from "~/components/environments/EnvironmentLabel";
import { AnimatedOrgBannerBar } from "~/components/billing/AnimatedOrgBannerBar";
import { OrgBannerKind, selectOrgBanner } from "~/components/billing/selectOrgBanner";
import { LinkButton } from "~/components/primitives/Buttons";
import { useEnvironment, useOptionalEnvironment } from "~/hooks/useEnvironment";
import {
  useOptionalOrganization,
  useOrganization,
  useBillingLimit,
  useCanManageBilling,
} from "~/hooks/useOrganizations";
import { useOptionalProject, useProject } from "~/hooks/useProject";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import { useCurrentPlan } from "~/routes/_app.orgs.$organizationSlug/route";
import { v3BillingLimitsPath, v3BillingPath, v3QueuesPath } from "~/utils/pathBuilder";
import { ENVIRONMENT_PAUSE_SOURCE_BILLING_LIMIT } from "~/utils/environmentPauseSource";

function getUpgradeResetDate(): Date {
  const nextMonth = new Date();
  nextMonth.setUTCDate(1);
  nextMonth.setUTCHours(0, 0, 0, 0);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  return nextMonth;
}

export function OrgBanner() {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();
  const billingLimit = useBillingLimit();
  const currentPlan = useCurrentPlan();
  const showSelfServe = useShowSelfServe();
  const location = useLocation();

  // Billing-limit pauses are surfaced by the dedicated limit banners (grace/rejected).
  // Don't also raise the generic "environment paused" warning for them — that would
  // alarm the user during the async resolve→ok window, when billing is already `ok`
  // but converge hasn't finished unpausing envs yet. Manual pauses still warn.
  const isPaused = !!(
    organization &&
    project &&
    environment &&
    environment.paused &&
    environment.pauseSource !== ENVIRONMENT_PAUSE_SOURCE_BILLING_LIMIT
  );
  const isArchived = !!(organization && project && environment && environment.archivedAt);

  const bannerKind = selectOrgBanner({
    billingLimit,
    hasExceededFreeTier: currentPlan?.v3Usage.hasExceededFreeTier === true,
    showEnvironmentWarning: isPaused || isArchived,
    showSelfServe,
  });

  const hideQueuesButton = location.pathname.endsWith("/queues");
  const hideBillingLimitBanner = location.pathname.endsWith("/settings/billing-limits");

  switch (bannerKind) {
    case OrgBannerKind.LimitRejected:
      return hideBillingLimitBanner ? null : <LimitRejectedBanner />;
    case OrgBannerKind.LimitGrace:
      return hideBillingLimitBanner ? null : <LimitGraceBanner />;
    case OrgBannerKind.NoLimitConfigured:
      return hideBillingLimitBanner ? null : <NoLimitConfiguredBanner />;
    case OrgBannerKind.Upgrade:
      return organization ? <UpgradeBanner /> : null;
    case OrgBannerKind.EnvironmentWarning:
      return isArchived ? (
        <ArchivedEnvironmentBanner />
      ) : (
        <PausedEnvironmentBanner hideButton={hideQueuesButton} />
      );
    default:
      return null;
  }
}

function LimitRejectedBanner() {
  const organization = useOrganization();
  const showSelfServe = useShowSelfServe();
  const canManageBilling = useCanManageBilling();
  const canResolve = showSelfServe && canManageBilling;

  return (
    <AnimatedOrgBannerBar
      show
      variant="error"
      action={
        canResolve ? (
          <LinkButton
            variant="danger/small"
            leadingIconClassName="px-0"
            to={v3BillingLimitsPath(organization)}
          >
            Resolve
          </LinkButton>
        ) : undefined
      }
    >
      <span className="font-medium">Billing limit exceeded</span> — New triggers are currently
      blocked.
      {!canResolve ? " Contact your organization administrator to resolve this issue." : null}
    </AnimatedOrgBannerBar>
  );
}

function LimitGraceBanner() {
  const organization = useOrganization();
  const billingLimit = useBillingLimit();
  const showSelfServe = useShowSelfServe();
  const canManageBilling = useCanManageBilling();
  const canResolve = showSelfServe && canManageBilling;

  const graceEndsAt =
    billingLimit?.isConfigured && billingLimit.limitState.status === "grace"
      ? billingLimit.limitState.graceEndsAt
      : null;

  return (
    <AnimatedOrgBannerBar
      show={graceEndsAt !== null}
      variant="error"
      action={
        canResolve ? (
          <LinkButton
            variant="danger/small"
            leadingIconClassName="px-0"
            to={v3BillingLimitsPath(organization)}
          >
            Resolve
          </LinkButton>
        ) : undefined
      }
    >
      <span className="font-medium">Billing limit reached</span> — Queues have been paused. New runs
      will continue to queue until <DateTime date={graceEndsAt ?? new Date()} includeTime />.
      {!canResolve ? " Contact your organization administrator to resolve this issue." : null}
    </AnimatedOrgBannerBar>
  );
}

function NoLimitConfiguredBanner() {
  const organization = useOrganization();
  const canManageBilling = useCanManageBilling();

  return (
    <AnimatedOrgBannerBar
      show
      variant="warning"
      action={
        canManageBilling ? (
          <LinkButton variant="tertiary/small" to={v3BillingLimitsPath(organization)}>
            Configure billing limit
          </LinkButton>
        ) : undefined
      }
    >
      {canManageBilling
        ? "Protect your organization from unexpected usage spikes."
        : "Billing limits are not configured for this organization. Contact an organization administrator to configure them."}
    </AnimatedOrgBannerBar>
  );
}

function UpgradeBanner() {
  const organization = useOrganization();
  const plan = useCurrentPlan();
  const freeCreditsDollars = (plan?.v3Subscription?.plan?.limits.includedUsage ?? 500) / 100;

  return (
    <AnimatedOrgBannerBar
      show={plan?.v3Usage.hasExceededFreeTier === true}
      variant="error"
      action={
        <LinkButton
          variant="danger/small"
          leadingIconClassName="px-0"
          to={v3BillingPath(organization)}
        >
          Upgrade
        </LinkButton>
      }
    >
      You have exceeded the monthly ${freeCreditsDollars} free credits. Existing runs will be queued
      and new runs won't be created until{" "}
      <DateTime date={getUpgradeResetDate()} includeTime={false} timeZone="utc" />, or you upgrade.
    </AnimatedOrgBannerBar>
  );
}

function PausedEnvironmentBanner({ hideButton }: { hideButton: boolean }) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <AnimatedOrgBannerBar
      show
      variant="warning"
      action={
        hideButton ? undefined : (
          <LinkButton
            variant="tertiary/small"
            to={v3QueuesPath(organization, project, environment)}
          >
            Manage
          </LinkButton>
        )
      }
    >
      {environmentFullTitle(environment)} environment paused. No new runs will be dequeued and
      executed.
    </AnimatedOrgBannerBar>
  );
}

function ArchivedEnvironmentBanner() {
  const environment = useEnvironment();

  return (
    <AnimatedOrgBannerBar show variant="warning">
      "{environment.branchName}" branch is archived and is read-only. No new runs will be dequeued
      and executed.
    </AnimatedOrgBannerBar>
  );
}
