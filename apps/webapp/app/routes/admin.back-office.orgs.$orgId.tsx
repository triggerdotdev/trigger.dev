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
  MAX_PROJECTS_INTENT,
  MAX_PROJECTS_SAVED_VALUE,
  MaxProjectsSection,
} from "~/components/admin/backOffice/MaxProjectsSection";
import { handleMaxProjectsAction } from "~/components/admin/backOffice/MaxProjectsSection.server";
import {
  RATE_LIMIT_INTENT,
  RATE_LIMIT_SAVED_VALUE,
  RateLimitSection,
} from "~/components/admin/backOffice/RateLimitSection";
import {
  handleRateLimitAction,
  resolveEffectiveRateLimit,
} from "~/components/admin/backOffice/RateLimitSection.server";
import { LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { prisma } from "~/db.server";
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
      maximumProjectCount: true,
    },
  });

  if (!org) {
    throw new Response(null, { status: 404 });
  }

  const effective = resolveEffectiveRateLimit(org.apiRateLimiterConfig);

  return typedjson({ org, effective });
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

  if (intent === RATE_LIMIT_INTENT) {
    const result = await handleRateLimitAction(formData, orgId, user.id);
    if (!result.ok) {
      return typedjson(
        { section: RATE_LIMIT_SAVED_VALUE, errors: result.errors },
        { status: 400 }
      );
    }
    return redirect(
      `/admin/back-office/orgs/${orgId}?${SAVED_QUERY_KEY}=${RATE_LIMIT_SAVED_VALUE}`
    );
  }

  return typedjson(
    { section: null, errors: { intent: ["Unknown intent."] } },
    { status: 400 }
  );
}

export default function BackOfficeOrgPage() {
  const { org, effective } = useTypedLoaderData<typeof loader>();
  const actionData = useTypedActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  const errorSection =
    actionData && "section" in actionData ? actionData.section : null;
  const errors =
    actionData && "errors" in actionData
      ? (actionData.errors as Record<string, string[] | undefined>)
      : null;

  const [searchParams, setSearchParams] = useSearchParams();
  const savedSection = searchParams.get(SAVED_QUERY_KEY);

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
    <div className="flex flex-col gap-6 py-4">
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

      <RateLimitSection
        effective={effective}
        errors={errorSection === RATE_LIMIT_SAVED_VALUE ? errors : null}
        savedJustNow={savedSection === RATE_LIMIT_SAVED_VALUE}
        isSubmitting={isSubmitting}
      />

      <MaxProjectsSection
        maximumProjectCount={org.maximumProjectCount}
        errors={errorSection === MAX_PROJECTS_SAVED_VALUE ? errors : null}
        savedJustNow={savedSection === MAX_PROJECTS_SAVED_VALUE}
        isSubmitting={isSubmitting}
      />
    </div>
  );
}
