import { CheckIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentSelector } from "~/components/navigation/EnvironmentSelector";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Feedback } from "~/components/Feedback";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import * as Property from "~/components/primitives/PropertyTable";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { InfoIconTooltip } from "~/components/primitives/Tooltip";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  LimitsPresenter,
  type FeatureInfo,
  type LimitsResult,
  type QuotaInfo,
  type RateLimitInfo,
} from "~/presenters/v3/LimitsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";
import {
  concurrencyPath,
  EnvironmentParamSchema,
  organizationBillingPath,
} from "~/utils/pathBuilder";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Limits | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Environment not found",
    });
  }

  const presenter = new LimitsPresenter();
  const [error, result] = await tryCatch(
    presenter.call({
      userId,
      projectId: project.id,
      organizationId: project.organizationId,
      environmentApiKey: environment.apiKey,
    })
  );

  if (error) {
    throw new Response(error.message, {
      status: 400,
    });
  }

  return typedjson(result);
};

export default function Page() {
  const data = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  // Auto-revalidate every 5 seconds to get fresh rate limit data
  useAutoRevalidate({ interval: 5000 });

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Limits" />
        <PageAccessories>
          <AdminDebugTooltip>
            <Property.Table>
              <Property.Item>
                <Property.Label>Plan</Property.Label>
                <Property.Value>{data.planName ?? "No plan"}</Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Organization ID</Property.Label>
                <Property.Value>{data.organizationId}</Property.Value>
              </Property.Item>
            </Property.Table>
          </AdminDebugTooltip>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={true}>
        <div className="mx-auto max-w-3xl p-4">
          <div className="flex flex-col gap-8">
            {/* Current Plan Section */}
            {data.planName && (
              <CurrentPlanSection
                planName={`${data.planName}Pro`}
                billingPath={organizationBillingPath(organization)}
              />
            )}

            {/* Concurrency Section */}
            <ConcurrencySection
              concurrencyPath={concurrencyPath(organization, project, environment)}
            />

            {/* Rate Limits Section */}
            <RateLimitsSection
              rateLimits={data.rateLimits}
              organization={organization}
              project={project}
              environment={environment}
            />

            {/* Quotas Section */}
            <QuotasSection
              quotas={data.quotas}
              batchConcurrency={data.batchConcurrency}
              planName={data.planName}
              billingPath={organizationBillingPath(organization)}
            />

            {/* Features Section */}
            <FeaturesSection
              features={data.features}
              planName={data.planName}
              billingPath={organizationBillingPath(organization)}
            />
          </div>
        </div>
      </PageBody>
    </PageContainer>
  );
}

function CurrentPlanSection({ planName, billingPath }: { planName: string; billingPath: string }) {
  const isPro = planName === "Pro";

  return (
    <div className="flex flex-col gap-3">
      <Header2>Current plan</Header2>
      <Table variant="bright/no-hover">
        <TableBody>
          <TableRow>
            <TableCell className="w-full text-sm">{planName}</TableCell>
            <TableCell alignment="right">
              {isPro ? (
                <Feedback
                  button={<Button variant="secondary/small">Request Enterprise</Button>}
                  defaultValue="help"
                />
              ) : (
                <LinkButton to={billingPath} variant="secondary/small">
                  View plans to upgrade
                </LinkButton>
              )}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

function ConcurrencySection({ concurrencyPath }: { concurrencyPath: string }) {
  return (
    <div className="flex flex-col gap-3">
      <Header2 className="flex items-center gap-1">
        Concurrency limits
        <InfoIconTooltip
          content="Concurrency limits control how many runs execute at the same time."
          disableHoverableContent
        />
      </Header2>
      <Table variant="bright/no-hover">
        <TableBody>
          <TableRow>
            <TableCell className="w-full text-sm">Concurrency</TableCell>
            <TableCell alignment="right">
              <LinkButton to={concurrencyPath} variant="secondary/small">
                Manage concurrency
              </LinkButton>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

function RateLimitsSection({
  rateLimits,
  organization,
  project,
  environment,
}: {
  rateLimits: LimitsResult["rateLimits"];
  organization: ReturnType<typeof useOrganization>;
  project: ReturnType<typeof useProject>;
  environment: ReturnType<typeof useEnvironment>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Header2 className="flex items-center gap-1">
          Rate Limits
          <InfoIconTooltip
            content="Rate limits control how many API requests can be made within a time window. They are tracked per API key."
            disableHoverableContent
          />
        </Header2>
        <EnvironmentSelector
          organization={organization}
          project={project}
          environment={environment}
          className="w-auto"
        />
      </div>
      <Table variant="bright/no-hover">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Rate Limit</TableHeaderCell>
            <TableHeaderCell alignment="right">
              <span className="flex items-center justify-end gap-x-1">
                Type
                <InfoIconTooltip
                  content={
                    <div className="flex max-w-xs flex-col gap-3 py-1">
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant="small">Token bucket</Badge>
                        <span className="text-text-bright">
                          Requests consume tokens from a bucket that refills over time. When empty,
                          requests are rate limited.
                        </span>
                      </div>
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant="small">Fixed window</Badge>
                        <span className="text-text-bright">
                          Allows a set number of requests per time window. The window resets at
                          fixed intervals.
                        </span>
                      </div>
                      <div className="flex flex-col items-start gap-1">
                        <Badge variant="small">Sliding window</Badge>
                        <span className="text-text-bright">
                          Allows a set number of requests per rolling time window. The limit is
                          continuously evaluated.
                        </span>
                      </div>
                    </div>
                  }
                  disableHoverableContent
                />
              </span>
            </TableHeaderCell>
            <TableHeaderCell alignment="right">Configuration</TableHeaderCell>
            <TableHeaderCell alignment="right">
              <span className="flex items-center justify-end gap-x-1">
                Available
                <InfoIconTooltip
                  content="Current available tokens for this environment's API key"
                  disableHoverableContent
                />
              </span>
            </TableHeaderCell>
            <TableHeaderCell alignment="right">Source</TableHeaderCell>
            <TableHeaderCell alignment="right">Upgrade</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          <RateLimitRow info={rateLimits.api} />
          <RateLimitRow info={rateLimits.batch} />
        </TableBody>
      </Table>
    </div>
  );
}

function RateLimitRow({ info }: { info: RateLimitInfo }) {
  const maxTokens = info.config.type === "tokenBucket" ? info.config.maxTokens : info.config.tokens;
  const percentage =
    info.currentTokens !== null && maxTokens > 0 ? info.currentTokens / maxTokens : null;

  return (
    <TableRow>
      <TableCell>
        <span className="flex items-center gap-1 text-sm">
          {info.name}
          <InfoIconTooltip content={info.description} disableHoverableContent />
        </span>
      </TableCell>
      <TableCell alignment="right">
        <div className="flex justify-end">
          <RateLimitTypeBadge config={info.config} />
        </div>
      </TableCell>
      <TableCell alignment="right">
        <RateLimitConfigDisplay config={info.config} />
      </TableCell>
      <TableCell alignment="right">
        {info.currentTokens !== null ? (
          <div className="flex flex-col items-end gap-0.5">
            <span
              className={cn(
                "font-medium tabular-nums",
                getUsageColorClass(percentage, "remaining")
              )}
            >
              {formatNumber(info.currentTokens)}
            </span>
            <span className="text-xs tabular-nums text-text-dimmed">
              of {formatNumber(maxTokens)}
            </span>
          </div>
        ) : (
          <span className="text-text-dimmed">–</span>
        )}
      </TableCell>
      <TableCell alignment="right">
        <SourceBadge source={info.source} />
      </TableCell>
      <TableCell alignment="right">
        <div className="flex justify-end">
          <Feedback
            button={<Button variant="tertiary/small">Contact us</Button>}
            defaultValue="help"
          />
        </div>
      </TableCell>
    </TableRow>
  );
}

function RateLimitTypeBadge({ config }: { config: RateLimitInfo["config"] }) {
  switch (config.type) {
    case "tokenBucket":
      return (
        <Badge variant="small" className="w-fit">
          Token bucket
        </Badge>
      );
    case "fixedWindow":
      return (
        <Badge variant="small" className="w-fit">
          Fixed window
        </Badge>
      );
    case "slidingWindow":
      return (
        <Badge variant="small" className="w-fit">
          Sliding window
        </Badge>
      );
  }
}

function RateLimitConfigDisplay({ config }: { config: RateLimitInfo["config"] }) {
  if (config.type === "tokenBucket") {
    return (
      <div className="flex flex-col items-end gap-0.5 text-xs">
        <span className="tabular-nums">
          <span className="text-text-dimmed">Max tokens:</span>{" "}
          <span className="font-medium text-text-bright">{formatNumber(config.maxTokens)}</span>
        </span>
        <span className="tabular-nums">
          <span className="text-text-dimmed">Refill:</span>{" "}
          <span className="font-medium text-text-bright">
            {formatNumber(config.refillRate)}/{config.interval}
          </span>
        </span>
      </div>
    );
  }

  if (config.type === "fixedWindow" || config.type === "slidingWindow") {
    return (
      <div className="flex flex-col items-end gap-0.5 text-xs">
        <span className="tabular-nums">
          <span className="text-text-dimmed">Tokens:</span>{" "}
          <span className="font-medium text-text-bright">{formatNumber(config.tokens)}</span>
        </span>
        <span className="tabular-nums">
          <span className="text-text-dimmed">Window:</span>{" "}
          <span className="font-medium text-text-bright">{config.window}</span>
        </span>
      </div>
    );
  }

  return <span className="text-text-dimmed">–</span>;
}

function QuotasSection({
  quotas,
  batchConcurrency,
  planName,
  billingPath,
}: {
  quotas: LimitsResult["quotas"];
  batchConcurrency: LimitsResult["batchConcurrency"];
  planName: string | null;
  billingPath: string;
}) {
  const isPro = planName === "Pro";
  // Collect all quotas that should be shown
  const quotaRows: QuotaInfo[] = [];

  // Always show projects
  quotaRows.push(quotas.projects);

  // Add plan-based quotas if they exist
  if (quotas.teamMembers) quotaRows.push(quotas.teamMembers);
  if (quotas.schedules) quotaRows.push(quotas.schedules);
  if (quotas.alerts) quotaRows.push(quotas.alerts);
  if (quotas.branches) quotaRows.push(quotas.branches);
  if (quotas.realtimeConnections) quotaRows.push(quotas.realtimeConnections);
  if (quotas.logRetentionDays) quotaRows.push(quotas.logRetentionDays);

  // Add queue size quotas if set
  if (quotas.devQueueSize.limit !== null) quotaRows.push(quotas.devQueueSize);
  if (quotas.deployedQueueSize.limit !== null) quotaRows.push(quotas.deployedQueueSize);

  return (
    <div className="flex flex-col gap-3">
      <Header2 className="flex items-center gap-1">
        Quotas
        <InfoIconTooltip
          content="Quotas define the maximum resources available to your organization."
          disableHoverableContent
        />
      </Header2>
      <Table variant="bright/no-hover">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Quota</TableHeaderCell>
            <TableHeaderCell alignment="right">Limit</TableHeaderCell>
            <TableHeaderCell alignment="right">Current</TableHeaderCell>
            <TableHeaderCell alignment="right">Source</TableHeaderCell>
            <TableHeaderCell alignment="right">Upgrade</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {quotaRows.map((quota) => (
            <QuotaRow
              key={quota.name}
              quota={quota}
              showUpgrade={quota.name === "Projects"}
              isPro={isPro}
              billingPath={billingPath}
            />
          ))}
          <TableRow>
            <TableCell className="flex w-full items-center gap-1">
              <span className="text-sm">Batch processing concurrency</span>
              <InfoIconTooltip
                content="Controls how many batch items can be processed simultaneously."
                disableHoverableContent
              />
            </TableCell>
            <TableCell alignment="right" className="font-medium tabular-nums">
              {formatNumber(batchConcurrency.limit)}
            </TableCell>
            <TableCell alignment="right" className="tabular-nums text-text-dimmed">
              –
            </TableCell>
            <TableCell alignment="right">
              <SourceBadge source={batchConcurrency.source} />
            </TableCell>
            <TableCell alignment="right">
              <div className="flex justify-end">
                {isPro ? (
                  <Feedback
                    button={<Button variant="tertiary/small">Contact us</Button>}
                    defaultValue="help"
                  />
                ) : (
                  <LinkButton to={billingPath} variant="tertiary/small">
                    View plans
                  </LinkButton>
                )}
              </div>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}

function QuotaRow({
  quota,
  showUpgrade,
  isPro,
  billingPath,
}: {
  quota: QuotaInfo;
  showUpgrade: boolean;
  isPro: boolean;
  billingPath: string;
}) {
  // For log retention, we don't show current usage as it's a duration, not a count
  const isRetentionQuota = quota.name === "Log retention";
  const percentage =
    !isRetentionQuota && quota.limit && quota.limit > 0 ? quota.currentUsage / quota.limit : null;

  return (
    <TableRow>
      <TableCell className="flex w-full items-center gap-1">
        <span className="text-sm">{quota.name}</span>
        <InfoIconTooltip content={quota.description} disableHoverableContent />
      </TableCell>
      <TableCell alignment="right" className="font-medium tabular-nums">
        {quota.limit !== null
          ? isRetentionQuota
            ? `${formatNumber(quota.limit)} days`
            : formatNumber(quota.limit)
          : "Unlimited"}
      </TableCell>
      <TableCell
        alignment="right"
        className={cn(
          "tabular-nums",
          isRetentionQuota ? "text-text-dimmed" : getUsageColorClass(percentage, "usage")
        )}
      >
        {isRetentionQuota ? "–" : formatNumber(quota.currentUsage)}
      </TableCell>
      <TableCell alignment="right">
        <SourceBadge source={quota.source} />
      </TableCell>
      <TableCell alignment="right">
        {showUpgrade ? (
          <div className="flex justify-end">
            {isPro ? (
              <Feedback
                button={<Button variant="tertiary/small">Contact us</Button>}
                defaultValue="help"
              />
            ) : (
              <LinkButton to={billingPath} variant="tertiary/small">
                View plans
              </LinkButton>
            )}
          </div>
        ) : null}
      </TableCell>
    </TableRow>
  );
}

function FeaturesSection({
  features,
  planName,
  billingPath,
}: {
  features: LimitsResult["features"];
  planName: string | null;
  billingPath: string;
}) {
  const isPro = planName === "Pro";
  const isFree = planName === "Free" || planName === null;

  return (
    <div className="flex flex-col gap-3">
      <Header2>Plan Features</Header2>
      <Table variant="bright/no-hover">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Feature</TableHeaderCell>
            <TableHeaderCell alignment="right">Status</TableHeaderCell>
            <TableHeaderCell alignment="right">Upgrade</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          <FeatureRow
            feature={features.hasStagingEnvironment}
            upgradeType={isFree ? "view-plans" : "none"}
            billingPath={billingPath}
          />
          <FeatureRow
            feature={features.support}
            upgradeType={isPro ? "contact-us" : "view-plans"}
            billingPath={billingPath}
          />
          <FeatureRow
            feature={features.includedUsage}
            upgradeType={isPro ? "contact-us" : "view-plans"}
            billingPath={billingPath}
          />
        </TableBody>
      </Table>
    </div>
  );
}

function FeatureRow({
  feature,
  upgradeType,
  billingPath,
}: {
  feature: FeatureInfo;
  upgradeType: "view-plans" | "contact-us" | "none";
  billingPath: string;
}) {
  const displayValue = () => {
    if (feature.name === "Included compute" && typeof feature.value === "number") {
      if (!feature.enabled || feature.value === 0) {
        return <span className="text-text-dimmed">None</span>;
      }
      return (
        <span className="font-medium text-text-bright">${formatNumber(feature.value / 100)}</span>
      );
    }

    if (feature.value !== undefined) {
      return <span className="font-medium text-text-bright">{feature.value}</span>;
    }

    return feature.enabled ? (
      <span className="inline-flex items-center gap-1 text-success">
        <CheckIcon className="size-4" />
        Enabled
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-text-dimmed">Not available</span>
    );
  };

  const renderUpgrade = () => {
    switch (upgradeType) {
      case "view-plans":
        return (
          <div className="flex justify-end">
            <LinkButton to={billingPath} variant="tertiary/small">
              View plans
            </LinkButton>
          </div>
        );
      case "contact-us":
        return (
          <div className="flex justify-end">
            <Feedback
              button={<Button variant="tertiary/small">Contact us</Button>}
              defaultValue="help"
            />
          </div>
        );
      case "none":
        return null;
    }
  };

  return (
    <TableRow>
      <TableCell className="flex w-full items-center gap-1">
        <span className="text-sm">{feature.name}</span>
        <InfoIconTooltip content={feature.description} disableHoverableContent />
      </TableCell>
      <TableCell alignment="right">{displayValue()}</TableCell>
      <TableCell alignment="right">{renderUpgrade()}</TableCell>
    </TableRow>
  );
}

/**
 * Returns the appropriate color class based on usage percentage.
 * @param percentage - The usage percentage (0-1 scale)
 * @param mode - "usage" means higher is worse (quotas), "remaining" means lower is worse (rate limits)
 * @returns Tailwind color class
 */
function getUsageColorClass(
  percentage: number | null,
  mode: "usage" | "remaining" = "usage"
): string {
  if (percentage === null) return "text-text-dimmed";

  if (mode === "remaining") {
    // For remaining tokens: 0 = bad (red), <=10% = warning (orange)
    if (percentage <= 0) return "text-error";
    if (percentage <= 0.1) return "text-warning";
    return "text-text-bright";
  } else {
    // For usage: 100% = bad (red), >=90% = warning (orange)
    if (percentage >= 1) return "text-error";
    if (percentage >= 0.9) return "text-warning";
    return "text-text-bright";
  }
}

function SourceBadge({ source }: { source: "default" | "plan" | "override" }) {
  const variants: Record<typeof source, { label: string; className: string }> = {
    default: {
      label: "Default",
      className: "bg-charcoal-700 text-text-dimmed",
    },
    plan: {
      label: "Plan",
      className: "bg-indigo-500/20 text-indigo-400",
    },
    override: {
      label: "Override",
      className: "bg-amber-500/20 text-amber-400",
    },
  };

  const variant = variants[source];

  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
        variant.className
      )}
    >
      {variant.label}
    </span>
  );
}
