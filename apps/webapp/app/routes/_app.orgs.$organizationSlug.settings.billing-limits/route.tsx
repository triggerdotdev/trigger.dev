import { parseWithZod } from "@conform-to/zod";
import type { MetaFunction } from "@remix-run/react";
import { json, redirect } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import {
  BillingAlertsSection,
  billingAlertsSchema,
  type BillingAlertsFormData,
} from "~/components/billing/BillingAlertsSection";
import {
  getBillingLimitMode,
  getEffectiveLimitCents,
  isPercentageAlertMode,
  MAX_ABSOLUTE_ALERTS,
  MAX_PERCENTAGE_ALERTS,
  MAX_PERCENTAGE_THRESHOLD,
  normalizeBillingAlertsFromApi,
  resetAlertsPayloadForLimitMode,
  shouldResetAlertsOnLimitChange,
  thresholdsToAlertPayload,
  hadSavedAlertsToClearOnLimitChange,
  thresholdValuesAreUnique,
} from "~/components/billing/billingAlertsFormat";
import { getSuggestedRecoveryLimitDollars } from "~/components/billing/billingLimitFormat";
import {
  BillingLimitConfigSection,
  billingLimitFormSchema,
} from "~/components/billing/BillingLimitConfigSection";
import {
  BillingLimitRecoveryPanel,
  billingLimitRecoveryFormSchema,
} from "~/components/billing/BillingLimitRecoveryPanel";
import { BillingLimitResolveProgress } from "~/components/billing/BillingLimitResolveProgress";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { prisma } from "~/db.server";
import { featuresForRequest } from "~/features.server";
import { useScrollContainerToTop } from "~/hooks/useScrollContainerToTop";
import { resolveOrgIdFromSlug } from "~/models/organization.server";
import {
  commitSession,
  getSession,
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
  setSuccessMessage,
} from "~/models/message.server";
import {
  getBillingAlerts,
  getBillingLimit,
  getCachedUsage,
  getCurrentPlan,
  resolveBillingLimit,
  setBillingAlert,
  setBillingLimit,
} from "~/services/platform.v3.server";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import type { BillingLimitResult } from "~/services/billingLimit.schemas";
import {
  getAlertsResetRequested,
  getEffectiveLimitCentsAfterLimitSave,
  getResolveSubmitted,
  getSubmittedResumeMode,
  isEnforcementActive,
} from "~/routes/_app.orgs.$organizationSlug.settings.billing-limits/billingLimitsRoute.server";
import {
  countBillingLimitPausedEnvironments,
  getBillingLimitQueuedRunCount,
} from "~/v3/services/billingLimit/getBillingLimitQueuedRunCount.server";
import {
  OrganizationParamsSchema,
  organizationPath,
  v3BillingLimitsPath,
  v3BillingPath,
} from "~/utils/pathBuilder";

const billingLimitsAuthorization = {
  action: "manage" as const,
  resource: { type: "billing-limits" as const },
};

export const meta: MetaFunction = () => {
  return [{ title: `Billing limits | Trigger.dev` }];
};

export const loader = dashboardLoader(
  {
    params: OrganizationParamsSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    authorization: {
      ...billingLimitsAuthorization,
      message: "With your current role, you can't manage billing limits.",
    },
  },
  async ({ params, request, user }) => {
    const userId = user.id;
    const { organizationSlug } = params;

    const { isManagedCloud } = featuresForRequest(request);
    if (!isManagedCloud) {
      return redirect(organizationPath({ slug: organizationSlug }));
    }

    const organization = await prisma.organization.findFirst({
      where: { slug: organizationSlug, members: { some: { userId } } },
    });

    if (!organization) {
      throw new Response(null, { status: 404, statusText: "Organization not found" });
    }

    const currentPlan = await getCurrentPlan(organization.id);
    if (currentPlan?.v3Subscription?.showSelfServe === false) {
      return redirect(v3BillingPath({ slug: organizationSlug }));
    }

    const [billingLimitError, billingLimit] = await tryCatch(getBillingLimit(organization.id));
    if (billingLimitError || !billingLimit) {
      throw new Response(null, {
        status: 404,
        statusText: `Billing limit error: ${billingLimitError ?? "not found"}`,
      });
    }

    const [alertsError, alerts] = await tryCatch(getBillingAlerts(organization.id));
    if (alertsError || !alerts) {
      throw new Response(null, {
        status: 404,
        statusText: `Billing alerts error: ${alertsError ?? "not found"}`,
      });
    }

    const planLimitCents = currentPlan?.v3Subscription?.plan?.limits.includedUsage ?? 500;
    const alertsResetRequested = getAlertsResetRequested(request);
    const resolveSubmitted = getResolveSubmitted(request);
    const submittedResumeMode = getSubmittedResumeMode(request);

    const firstDayOfMonth = new Date();
    firstDayOfMonth.setUTCDate(1);
    firstDayOfMonth.setUTCHours(0, 0, 0, 0);

    const firstDayOfNextMonth = new Date();
    firstDayOfNextMonth.setUTCDate(1);
    firstDayOfNextMonth.setUTCHours(0, 0, 0, 0);
    firstDayOfNextMonth.setUTCMonth(firstDayOfNextMonth.getUTCMonth() + 1);

    const [usage, queuedRunCount, billingLimitPauseEnvCount] = await Promise.all([
      getCachedUsage(organization.id, { from: firstDayOfMonth, to: firstDayOfNextMonth }),
      isEnforcementActive(billingLimit)
        ? getBillingLimitQueuedRunCount(organization.id)
        : Promise.resolve(0),
      countBillingLimitPausedEnvironments(organization.id),
    ]);

    const currentSpendCents = usage?.cents ?? 0;
    const suggestedNewLimitDollars = isEnforcementActive(billingLimit)
      ? getSuggestedRecoveryLimitDollars(
          billingLimit.isConfigured ? billingLimit.effectiveAmountCents : null,
          currentSpendCents
        )
      : 0;

    const alertsFormData = normalizeBillingAlertsFromApi(alerts, {
      planLimitCents,
      effectiveLimitCents: getEffectiveLimitCents(billingLimit, planLimitCents),
    });

    return typedjson({
      billingLimit,
      alerts: alertsFormData,
      planLimitCents,
      isRecoveryMode: isEnforcementActive(billingLimit),
      alertsResetRequested,
      currentSpendCents,
      queuedRunCount,
      billingLimitPauseEnvCount,
      resolveSubmitted,
      submittedResumeMode,
      suggestedNewLimitDollars,
    });
  }
);

type LoaderData = {
  billingLimit: BillingLimitResult;
  alerts: BillingAlertsFormData;
  planLimitCents: number;
  isRecoveryMode: boolean;
  alertsResetRequested: boolean;
  currentSpendCents: number;
  queuedRunCount: number;
  billingLimitPauseEnvCount: number;
  resolveSubmitted: boolean;
  submittedResumeMode: "queue" | "new_only" | null;
  suggestedNewLimitDollars: number;
};

export const action = dashboardAction(
  {
    params: OrganizationParamsSchema,
    context: async (params) => {
      const organizationId = await resolveOrgIdFromSlug(params.organizationSlug);
      return organizationId ? { organizationId } : {};
    },
    authorization: billingLimitsAuthorization,
  },
  async ({ request, params, user }) => {
    const userId = user.id;
    const { organizationSlug } = params;

    const organization = await prisma.organization.findFirst({
      where: { slug: organizationSlug, members: { some: { userId } } },
    });

    if (!organization) {
      return redirectWithErrorMessage(
        v3BillingPath({ slug: organizationSlug }),
        request,
        "You are not authorized to update billing settings"
      );
    }

    const currentPlan = await getCurrentPlan(organization.id);
    if (currentPlan?.v3Subscription?.showSelfServe === false) {
      return redirect(v3BillingPath({ slug: organizationSlug }));
    }

    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "billing-alerts") {
      const submission = parseWithZod(formData, { schema: billingAlertsSchema });
      if (submission.status !== "success") {
        return json({ formIntent: "billing-alerts", submission: submission.reply() });
      }

      const [billingLimitError, billingLimit] = await tryCatch(getBillingLimit(organization.id));
      if (billingLimitError || !billingLimit) {
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          "Failed to load billing limit for alerts"
        );
      }

      const planLimitCents = currentPlan?.v3Subscription?.plan?.limits.includedUsage ?? 500;
      const billingLimitMode = getBillingLimitMode(billingLimit);
      const maxAlerts = isPercentageAlertMode(billingLimitMode)
        ? MAX_PERCENTAGE_ALERTS
        : MAX_ABSOLUTE_ALERTS;

      if (submission.value.alertLevels.length > maxAlerts) {
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          `You can add at most ${maxAlerts} alerts`
        );
      }

      if (
        submission.value.alertLevels.some(
          (threshold) => !Number.isFinite(threshold) || threshold <= 0
        )
      ) {
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          "Each alert must be greater than 0"
        );
      }

      if (!thresholdValuesAreUnique(submission.value.alertLevels)) {
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          "Each alert must be unique"
        );
      }

      if (
        isPercentageAlertMode(billingLimitMode) &&
        submission.value.alertLevels.some((threshold) => threshold > MAX_PERCENTAGE_THRESHOLD)
      ) {
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          "Alerts cannot exceed 100% of your billing limit"
        );
      }

      const effectiveLimitCents = getEffectiveLimitCents(billingLimit, planLimitCents);
      const alertPayload = thresholdsToAlertPayload(
        submission.value.alertLevels,
        billingLimitMode,
        effectiveLimitCents
      );

      const [error] = await tryCatch(
        setBillingAlert(organization.id, {
          emails: submission.value.emails,
          ...alertPayload,
        })
      );

      if (error) {
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          "Failed to update billing alerts"
        );
      }

      return redirectWithSuccessMessage(
        v3BillingLimitsPath({ slug: organizationSlug }),
        request,
        "Billing alerts updated"
      );
    }

    if (intent === "billing-limit") {
      const submission = parseWithZod(formData, { schema: billingLimitFormSchema });
      if (submission.status !== "success") {
        return json({ formIntent: "billing-limit", submission: submission.reply() });
      }

      const [billingLimitError, billingLimit] = await tryCatch(getBillingLimit(organization.id));
      if (billingLimitError || !billingLimit) {
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          "Failed to load billing limit"
        );
      }

      if (isEnforcementActive(billingLimit)) {
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          "Resolve the active billing limit before changing settings"
        );
      }

      const cancelInProgressRuns =
        submission.value.mode === "none" ? false : (submission.value.cancelInProgressRuns ?? false);
      const previousMode = getBillingLimitMode(billingLimit);
      const resettingAlerts = shouldResetAlertsOnLimitChange(previousMode, submission.value.mode);
      const planLimitCents = currentPlan?.v3Subscription?.plan?.limits.includedUsage ?? 500;

      try {
        if (submission.value.mode === "custom") {
          await setBillingLimit(organization.id, {
            mode: "custom",
            amountCents: Math.round(submission.value.amount * 100),
            cancelInProgressRuns,
          });
        } else if (submission.value.mode === "plan") {
          await setBillingLimit(organization.id, {
            mode: "plan",
            cancelInProgressRuns,
          });
        } else {
          await setBillingLimit(organization.id, {
            mode: "none",
            cancelInProgressRuns: false,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to update billing limit";
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          message
        );
      }

      if (resettingAlerts) {
        const [alertsError, existingAlerts] = await tryCatch(getBillingAlerts(organization.id));
        if (alertsError || !existingAlerts) {
          return redirectWithErrorMessage(
            v3BillingLimitsPath({ slug: organizationSlug }),
            request,
            "Billing limit updated, but failed to clear billing alerts"
          );
        }

        const existingAlertsFormData = normalizeBillingAlertsFromApi(existingAlerts, {
          planLimitCents,
          effectiveLimitCents: getEffectiveLimitCents(billingLimit, planLimitCents),
        });

        const shouldClearSavedAlerts = hadSavedAlertsToClearOnLimitChange(
          existingAlertsFormData,
          billingLimit,
          planLimitCents
        );

        if (shouldClearSavedAlerts) {
          const effectiveLimitCents = getEffectiveLimitCentsAfterLimitSave(
            submission.value.mode,
            planLimitCents,
            submission.value.mode === "custom" ? submission.value.amount : undefined
          );

          const [clearAlertsError] = await tryCatch(
            setBillingAlert(
              organization.id,
              resetAlertsPayloadForLimitMode(
                submission.value.mode,
                effectiveLimitCents,
                existingAlerts.emails ?? []
              )
            )
          );

          if (clearAlertsError) {
            return redirectWithErrorMessage(
              v3BillingLimitsPath({ slug: organizationSlug }),
              request,
              "Billing limit updated, but failed to clear billing alerts"
            );
          }

          const session = await getSession(request.headers.get("cookie"));
          setSuccessMessage(session, "Billing limit updated");

          return redirect(`${v3BillingLimitsPath({ slug: organizationSlug })}?alertsReset=1`, {
            headers: {
              "Set-Cookie": await commitSession(session),
            },
          });
        }
      }

      const session = await getSession(request.headers.get("cookie"));
      setSuccessMessage(session, "Billing limit updated");

      return redirect(v3BillingLimitsPath({ slug: organizationSlug }), {
        headers: {
          "Set-Cookie": await commitSession(session),
        },
      });
    }

    if (intent === "billing-limit-resolve") {
      const submission = parseWithZod(formData, { schema: billingLimitRecoveryFormSchema });
      if (submission.status !== "success") {
        return json({ formIntent: "billing-limit-resolve", submission: submission.reply() });
      }

      const [billingLimitError, billingLimit] = await tryCatch(getBillingLimit(organization.id));
      if (billingLimitError || !billingLimit) {
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          "Failed to load billing limit"
        );
      }

      if (!isEnforcementActive(billingLimit)) {
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          "Billing limit is not in an enforced state"
        );
      }

      const resolvePayload =
        submission.value.action === "increase"
          ? {
              action: "increase" as const,
              newAmountCents: Math.round((submission.value.newAmount ?? 0) * 100),
              resumeMode: submission.value.resumeMode,
            }
          : {
              action: "remove" as const,
              resumeMode: submission.value.resumeMode,
            };

      const [error] = await tryCatch(resolveBillingLimit(organization.id, resolvePayload));

      if (error) {
        const message = error instanceof Error ? error.message : "Failed to resolve billing limit";
        return redirectWithErrorMessage(
          v3BillingLimitsPath({ slug: organizationSlug }),
          request,
          message
        );
      }

      const session = await getSession(request.headers.get("cookie"));
      setSuccessMessage(session, "Billing limit resolved");

      const resumeModeParam = submission.value.resumeMode;
      return redirect(
        `${v3BillingLimitsPath({ slug: organizationSlug })}?resolved=1&resumeMode=${resumeModeParam}`,
        {
          headers: {
            "Set-Cookie": await commitSession(session),
          },
        }
      );
    }

    return json({ error: "Unknown form intent" }, { status: 400 });
  }
);

export default function Page() {
  const {
    billingLimit,
    alerts,
    planLimitCents,
    isRecoveryMode,
    alertsResetRequested,
    currentSpendCents,
    queuedRunCount,
    billingLimitPauseEnvCount,
    resolveSubmitted,
    submittedResumeMode,
    suggestedNewLimitDollars,
  } = useTypedLoaderData<LoaderData>();

  const showResolveProgress = resolveSubmitted && billingLimitPauseEnvCount > 0;
  const pageBodyRef = useScrollContainerToTop<HTMLDivElement>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Billing limits" />
        <PageAccessories>
          <AdminDebugTooltip />
        </PageAccessories>
      </NavBar>
      <PageBody scrollable ref={pageBodyRef}>
        <div className="mx-auto flex max-w-3xl flex-col gap-10 px-4 pb-4 pt-10">
          <BillingLimitResolveProgress
            show={showResolveProgress}
            cancellingQueuedRuns={submittedResumeMode === "new_only"}
          />
          {isRecoveryMode && billingLimit.isConfigured ? (
            <BillingLimitRecoveryPanel
              billingLimit={billingLimit}
              currentSpendCents={currentSpendCents}
              queuedRunCount={queuedRunCount}
              suggestedNewLimitDollars={suggestedNewLimitDollars}
            />
          ) : (
            <BillingLimitConfigSection
              billingLimit={billingLimit}
              planLimitCents={planLimitCents}
            />
          )}
          <BillingAlertsSection
            alerts={alerts}
            billingLimit={billingLimit}
            planLimitCents={planLimitCents}
            alertsResetRequested={alertsResetRequested}
          />
        </div>
      </PageBody>
    </PageContainer>
  );
}
