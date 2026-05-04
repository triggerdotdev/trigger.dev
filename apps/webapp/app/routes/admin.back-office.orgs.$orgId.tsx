import { useNavigation, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useEffect } from "react";
import {
  redirect,
  typedjson,
  useTypedActionData,
  useTypedLoaderData,
} from "remix-typedjson";
import {
  API_RATE_LIMIT_INTENT,
  API_RATE_LIMIT_SAVED_VALUE,
  ApiRateLimitSection,
} from "~/components/admin/backOffice/ApiRateLimitSection";
import {
  handleApiRateLimitAction,
  resolveEffectiveApiRateLimit,
} from "~/components/admin/backOffice/ApiRateLimitSection.server";
import {
  BATCH_RATE_LIMIT_INTENT,
  BATCH_RATE_LIMIT_SAVED_VALUE,
  BatchRateLimitSection,
} from "~/components/admin/backOffice/BatchRateLimitSection";
import {
  handleBatchRateLimitAction,
  resolveEffectiveBatchRateLimit,
} from "~/components/admin/backOffice/BatchRateLimitSection.server";
import {
  CONCURRENCY_QUOTA_INTENT,
  CONCURRENCY_QUOTA_SAVED_VALUE,
  ConcurrencyQuotaSection,
} from "~/components/admin/backOffice/ConcurrencyQuotaSection";
import { handleConcurrencyQuotaAction } from "~/components/admin/backOffice/ConcurrencyQuotaSection.server";
import {
  MAX_PROJECTS_INTENT,
  MAX_PROJECTS_SAVED_VALUE,
  MaxProjectsSection,
} from "~/components/admin/backOffice/MaxProjectsSection";
import { handleMaxProjectsAction } from "~/components/admin/backOffice/MaxProjectsSection.server";
import { LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
import { getCurrentPlan } from "~/services/platform.v3.server";
import { requireUser } from "~/services/session.server";

const SAVED_QUERY_KEY = "saved";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }

  const orgId = params.orgId;
  if (!orgId) {
    throw new Response(null, { status: 404 });
  }

  const org = await prisma.organization.findFirst({
    where: { id: orgId },
    select: {
      id: true,
      slug: true,
      title: true,
      createdAt: true,
      apiRateLimiterConfig: true,
      batchRateLimitConfig: true,
      maximumProjectCount: true,
    },
  });

  if (!org) {
    throw new Response(null, { status: 404 });
  }

  const apiEffective = resolveEffectiveApiRateLimit(org.apiRateLimiterConfig);
  const batchEffective = resolveEffectiveBatchRateLimit(
    org.batchRateLimitConfig
  );

  const currentPlan = await getCurrentPlan(org.id);
  const concurrencyAddOn = currentPlan?.v3Subscription?.addOns?.concurrentRuns;
  const concurrencyQuota = {
    currentQuota: concurrencyAddOn?.quota ?? 0,
    purchased: concurrencyAddOn?.purchased ?? 0,
  };

  return typedjson({ org, apiEffective, batchEffective, concurrencyQuota });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const user = await requireUser(request);
  if (!user.admin) {
    return redirect("/");
  }

  const orgId = params.orgId;
  if (!orgId) {
    throw new Response(null, { status: 404 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === MAX_PROJECTS_INTENT) {
    const result = await handleMaxProjectsAction(formData, orgId, user.id);
    if (!result.ok) {
      return typedjson(
        { section: MAX_PROJECTS_SAVED_VALUE, errors: result.errors },
        { status: 400 }
      );
    }
    return redirect(
      `/admin/back-office/orgs/${orgId}?${SAVED_QUERY_KEY}=${MAX_PROJECTS_SAVED_VALUE}`
    );
  }

  if (intent === API_RATE_LIMIT_INTENT) {
    const result = await handleApiRateLimitAction(formData, orgId, user.id);
    if (!result.ok) {
      return typedjson(
        { section: API_RATE_LIMIT_SAVED_VALUE, errors: result.errors },
        { status: 400 }
      );
    }
    return redirect(
      `/admin/back-office/orgs/${orgId}?${SAVED_QUERY_KEY}=${API_RATE_LIMIT_SAVED_VALUE}`
    );
  }

  if (intent === BATCH_RATE_LIMIT_INTENT) {
    const result = await handleBatchRateLimitAction(formData, orgId, user.id);
    if (!result.ok) {
      return typedjson(
        { section: BATCH_RATE_LIMIT_SAVED_VALUE, errors: result.errors },
        { status: 400 }
      );
    }
    return redirect(
      `/admin/back-office/orgs/${orgId}?${SAVED_QUERY_KEY}=${BATCH_RATE_LIMIT_SAVED_VALUE}`
    );
  }

  if (intent === CONCURRENCY_QUOTA_INTENT) {
    const result = await handleConcurrencyQuotaAction(formData, orgId, user.id);
    if (!result.ok) {
      return typedjson(
        {
          section: CONCURRENCY_QUOTA_SAVED_VALUE,
          errors: result.errors,
          formError: result.formError ?? null,
        },
        { status: 400 }
      );
    }
    return redirect(
      `/admin/back-office/orgs/${orgId}?${SAVED_QUERY_KEY}=${CONCURRENCY_QUOTA_SAVED_VALUE}`
    );
  }

  return typedjson(
    { section: null, errors: { intent: ["Unknown intent."] } },
    { status: 400 }
  );
}

export default function BackOfficeOrgPage() {
  const { org, apiEffective, batchEffective, concurrencyQuota } =
    useTypedLoaderData<typeof loader>();
  const actionData = useTypedActionData<typeof action>();
  const navigation = useNavigation();
  const submittingIntent = navigation.formData?.get("intent");
  const isSubmittingApi =
    navigation.state !== "idle" && submittingIntent === API_RATE_LIMIT_INTENT;
  const isSubmittingBatch =
    navigation.state !== "idle" && submittingIntent === BATCH_RATE_LIMIT_INTENT;
  const isSubmittingMaxProjects =
    navigation.state !== "idle" && submittingIntent === MAX_PROJECTS_INTENT;
  const isSubmittingConcurrencyQuota =
    navigation.state !== "idle" &&
    submittingIntent === CONCURRENCY_QUOTA_INTENT;

  const errorSection =
    actionData && "section" in actionData ? actionData.section : null;
  const errors =
    actionData && "errors" in actionData
      ? (actionData.errors as Record<string, string[] | undefined>)
      : null;
  const formError =
    actionData && "formError" in actionData
      ? ((actionData as { formError?: string | null }).formError ?? null)
      : null;

  const [searchParams, setSearchParams] = useSearchParams();
  const savedSectionRaw = searchParams.get(SAVED_QUERY_KEY);
  // If the action just returned errors for the same section, hide the
  // "Saved." banner so it doesn't render alongside field errors. Suppressing
  // here propagates to every read site (auto-dismiss + JSX comparisons).
  const savedSection =
    errors && errorSection === savedSectionRaw ? null : savedSectionRaw;

  // Auto-dismiss the "saved" banner after a few seconds.
  useEffect(() => {
    if (!savedSection) return;
    const t = setTimeout(() => {
      setSearchParams(
        (prev) => {
          prev.delete(SAVED_QUERY_KEY);
          return prev;
        },
        { replace: true, preventScrollReset: true }
      );
    }, 3000);
    return () => clearTimeout(t);
  }, [savedSection, setSearchParams]);

  return (
    <div className="flex shrink-0 flex-col gap-6 pb-12 pt-4">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <Header1>{org.title}</Header1>
          <Paragraph variant="small" className="text-text-dimmed">
            <CopyableText value={org.slug} /> · <CopyableText value={org.id} />
          </Paragraph>
        </div>
        <LinkButton to="/admin/orgs" variant="tertiary/small">
          Back to organizations
        </LinkButton>
      </div>

      <ApiRateLimitSection
        effective={apiEffective}
        errors={errorSection === API_RATE_LIMIT_SAVED_VALUE ? errors : null}
        savedJustNow={savedSection === API_RATE_LIMIT_SAVED_VALUE}
        isSubmitting={isSubmittingApi}
      />

      <BatchRateLimitSection
        effective={batchEffective}
        errors={errorSection === BATCH_RATE_LIMIT_SAVED_VALUE ? errors : null}
        savedJustNow={savedSection === BATCH_RATE_LIMIT_SAVED_VALUE}
        isSubmitting={isSubmittingBatch}
      />

      <MaxProjectsSection
        maximumProjectCount={org.maximumProjectCount}
        errors={errorSection === MAX_PROJECTS_SAVED_VALUE ? errors : null}
        savedJustNow={savedSection === MAX_PROJECTS_SAVED_VALUE}
        isSubmitting={isSubmittingMaxProjects}
      />

      <ConcurrencyQuotaSection
        currentQuota={concurrencyQuota.currentQuota}
        purchased={concurrencyQuota.purchased}
        errors={errorSection === CONCURRENCY_QUOTA_SAVED_VALUE ? errors : null}
        formError={
          errorSection === CONCURRENCY_QUOTA_SAVED_VALUE ? formError : null
        }
        savedJustNow={savedSection === CONCURRENCY_QUOTA_SAVED_VALUE}
        isSubmitting={isSubmittingConcurrencyQuota}
      />
    </div>
  );
}
