import { Form, useNavigation, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { Prisma } from "@trigger.dev/database";
import { useEffect, useState } from "react";
import { redirect, typedjson, useTypedActionData, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { FormError } from "~/components/primitives/FormError";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import {
  RateLimitTokenBucketConfig,
  type RateLimiterConfig,
} from "~/services/authorizationRateLimitMiddleware.server";
import { logger } from "~/services/logger.server";
import { type Duration } from "~/services/rateLimiter.server";
import { requireUser } from "~/services/session.server";

type EffectiveRateLimit = {
  source: "override" | "default";
  config: RateLimiterConfig;
};

function systemDefaultRateLimit(): RateLimiterConfig {
  return {
    type: "tokenBucket",
    refillRate: env.API_RATE_LIMIT_REFILL_RATE,
    interval: env.API_RATE_LIMIT_REFILL_INTERVAL as Duration,
    maxTokens: env.API_RATE_LIMIT_MAX,
  };
}

function resolveEffectiveRateLimit(override: unknown): EffectiveRateLimit {
  if (override == null) {
    return { source: "default", config: systemDefaultRateLimit() };
  }
  const parsed = RateLimitTokenBucketConfig.safeParse(override);
  if (parsed.success) {
    return { source: "override", config: parsed.data };
  }
  // Override exists but isn't tokenBucket (fixedWindow/slidingWindow). We can't
  // edit it from this UI — show the default and let the admin know.
  return { source: "default", config: systemDefaultRateLimit() };
}

function parseDurationToMs(duration: string): number {
  const match = duration.trim().match(/^(\d+)\s*(ms|s|m|h|d)$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "ms":
      return value;
    case "s":
      return value * 1_000;
    case "m":
      return value * 60_000;
    case "h":
      return value * 3_600_000;
    case "d":
      return value * 86_400_000;
    default:
      return 0;
  }
}

function describeRateLimit(
  refillRate: number,
  intervalMs: number,
  maxTokens: number
): { sustained: string; burst: string } | null {
  if (refillRate <= 0 || intervalMs <= 0 || maxTokens <= 0) return null;
  const perMin = Math.round((refillRate * 60_000) / intervalMs);
  return {
    sustained: `${perMin.toLocaleString()} requests per minute`,
    burst: `${maxTokens.toLocaleString()} request burst allowance`,
  };
}

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
    },
  });

  if (!org) {
    throw new Response(null, { status: 404 });
  }

  const effective = resolveEffectiveRateLimit(org.apiRateLimiterConfig);
  const overrideIsIncompatible =
    org.apiRateLimiterConfig != null && effective.source === "default";

  return typedjson({
    org,
    effective,
    overrideIsIncompatible,
  });
}

const SetRateLimitSchema = z.object({
  intent: z.literal("set-rate-limit"),
  refillRate: z.coerce.number().int().min(1),
  interval: z.string().min(1),
  maxTokens: z.coerce.number().int().min(1),
});

const ResetRateLimitSchema = z.object({
  intent: z.literal("reset-rate-limit"),
});

const ActionSchema = z.discriminatedUnion("intent", [
  SetRateLimitSchema,
  ResetRateLimitSchema,
]);

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
  const submission = ActionSchema.safeParse(Object.fromEntries(formData));
  if (!submission.success) {
    return json(
      { errors: submission.error.flatten().fieldErrors },
      { status: 400 }
    );
  }

  const existing = await prisma.organization.findFirst({
    where: { id: orgId },
    select: { apiRateLimiterConfig: true },
  });
  if (!existing) {
    throw new Response(null, { status: 404 });
  }

  let next: RateLimiterConfig | null;
  if (submission.data.intent === "set-rate-limit") {
    const built = RateLimitTokenBucketConfig.safeParse({
      type: "tokenBucket",
      refillRate: submission.data.refillRate,
      interval: submission.data.interval,
      maxTokens: submission.data.maxTokens,
    });
    if (!built.success) {
      return json(
        { errors: built.error.flatten().fieldErrors },
        { status: 400 }
      );
    }
    next = built.data;
  } else {
    next = null;
  }

  await prisma.organization.update({
    where: { id: orgId },
    data: {
      apiRateLimiterConfig: next === null ? Prisma.JsonNull : (next as any),
    },
  });

  logger.info("admin.backOffice.rateLimit", {
    adminUserId: user.id,
    orgId,
    intent: submission.data.intent,
    previous: existing.apiRateLimiterConfig,
    next,
  });

  return redirect(`/admin/back-office/orgs/${orgId}?saved=1`);
}

export default function BackOfficeOrgPage() {
  const { org, effective, overrideIsIncompatible } =
    useTypedLoaderData<typeof loader>();
  const actionData = useTypedActionData<typeof action>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state !== "idle";

  const errors =
    actionData && "errors" in actionData ? actionData.errors : null;
  const hasFieldErrors =
    !!errors && typeof errors === "object" && Object.keys(errors).length > 0;
  const fieldError = (field: string) =>
    errors && typeof errors === "object" && field in errors
      ? (errors as Record<string, string[] | undefined>)[field]?.[0]
      : undefined;

  const current =
    effective.config.type === "tokenBucket" ? effective.config : null;

  const [isEditing, setIsEditing] = useState(false);
  const [refillRate, setRefillRate] = useState(
    current ? String(current.refillRate) : ""
  );
  const [intervalStr, setIntervalStr] = useState(
    current ? String(current.interval) : ""
  );
  const [maxTokens, setMaxTokens] = useState(
    current ? String(current.maxTokens) : ""
  );

  const [searchParams, setSearchParams] = useSearchParams();
  const savedJustNow = searchParams.get("saved") === "1";

  // If a submit comes back with validation errors, re-open edit mode so the
  // admin can see and correct them without clicking Edit again.
  useEffect(() => {
    if (hasFieldErrors) setIsEditing(true);
  }, [hasFieldErrors]);

  // On successful save, drop back to view mode (the component stays mounted
  // across the same-route redirect, so `isEditing` wouldn't reset on its own).
  useEffect(() => {
    if (savedJustNow) setIsEditing(false);
  }, [savedJustNow]);

  // Auto-dismiss the "saved" banner after a few seconds.
  useEffect(() => {
    if (!savedJustNow) return;
    const t = setTimeout(() => {
      setSearchParams(
        (prev) => {
          prev.delete("saved");
          return prev;
        },
        { replace: true, preventScrollReset: true }
      );
    }, 3000);
    return () => clearTimeout(t);
  }, [savedJustNow, setSearchParams]);

  const currentDescription = current
    ? describeRateLimit(
        current.refillRate,
        parseDurationToMs(String(current.interval)),
        current.maxTokens
      )
    : null;

  const previewDescription = describeRateLimit(
    Number(refillRate) || 0,
    parseDurationToMs(intervalStr),
    Number(maxTokens) || 0
  );

  const cancelEdit = () => {
    setRefillRate(current ? String(current.refillRate) : "");
    setIntervalStr(current ? String(current.interval) : "");
    setMaxTokens(current ? String(current.maxTokens) : "");
    setIsEditing(false);
  };

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

      <section className="flex flex-col gap-3 rounded-md border border-charcoal-700 bg-charcoal-800 p-4">
        <div className="flex items-center justify-between">
          <Header2>API rate limit</Header2>
          {!isEditing && (
            <Button
              variant="tertiary/small"
              onClick={() => setIsEditing(true)}
              disabled={isSubmitting}
            >
              Edit
            </Button>
          )}
        </div>

        {savedJustNow && (
          <div className="rounded-md border border-green-600/40 bg-green-600/10 px-3 py-2">
            <Paragraph variant="small" className="text-green-500">
              Rate limit saved.
            </Paragraph>
          </div>
        )}

        <Paragraph variant="small">
          Status:{" "}
          {effective.source === "override"
            ? "Custom override active."
            : "Using system default."}
          {overrideIsIncompatible && (
            <span className="ml-2 text-amber-500">
              (An override exists but is not a tokenBucket — not editable here.)
            </span>
          )}
        </Paragraph>

        {!isEditing ? (
          <Property.Table>
            {currentDescription ? (
              <>
                <Property.Item>
                  <Property.Label>Sustained rate</Property.Label>
                  <Property.Value>{currentDescription.sustained}</Property.Value>
                </Property.Item>
                <Property.Item>
                  <Property.Label>Burst allowance</Property.Label>
                  <Property.Value>{currentDescription.burst}</Property.Value>
                </Property.Item>
              </>
            ) : (
              <Property.Item>
                <Property.Value>
                  No editable rate limit configured.
                </Property.Value>
              </Property.Item>
            )}
          </Property.Table>
        ) : (
          <Form method="post" className="flex flex-col gap-3 pt-2">
            <input type="hidden" name="intent" value="set-rate-limit" />

            <div className="flex flex-col gap-1">
              <Label>Refill rate (tokens per interval)</Label>
              <Input
                name="refillRate"
                type="number"
                min={1}
                value={refillRate}
                onChange={(e) => setRefillRate(e.target.value)}
                required
              />
              <FormError>{fieldError("refillRate")}</FormError>
            </div>

            <div className="flex flex-col gap-1">
              <Label>Interval (e.g. 10s, 1m)</Label>
              <Input
                name="interval"
                type="text"
                value={intervalStr}
                onChange={(e) => setIntervalStr(e.target.value)}
                required
              />
              <FormError>{fieldError("interval")}</FormError>
            </div>

            <div className="flex flex-col gap-1">
              <Label>Max tokens (burst allowance)</Label>
              <Input
                name="maxTokens"
                type="number"
                min={1}
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                required
              />
              <FormError>{fieldError("maxTokens")}</FormError>
            </div>

            <Paragraph variant="small" className="text-text-dimmed">
              {previewDescription
                ? `Preview: ${previewDescription.sustained} · ${previewDescription.burst}.`
                : "Preview: enter valid values to see the effective limit."}
            </Paragraph>

            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary/medium" disabled={isSubmitting}>
                Save
              </Button>
              <Button
                type="button"
                variant="tertiary/medium"
                onClick={cancelEdit}
                disabled={isSubmitting}
              >
                Cancel
              </Button>
            </div>
          </Form>
        )}
      </section>
    </div>
  );
}
