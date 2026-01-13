import { InformationCircleIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { motion, useMotionValue, useTransform } from "framer-motion";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { AdminDebugTooltip } from "~/components/admin/debugTooltip";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { findProjectBySlug } from "~/models/project.server";
import {
  LimitsPresenter,
  type LimitsResult,
  type RateLimitInfo,
  type ConcurrencyLimitInfo,
  type QuotaInfo,
} from "~/presenters/v3/LimitsPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { formatNumber } from "~/utils/numberFormatter";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Limits | Trigger.dev`,
    },
  ];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response(undefined, {
      status: 404,
      statusText: "Project not found",
    });
  }

  const presenter = new LimitsPresenter();
  const [error, result] = await tryCatch(
    presenter.call({
      userId,
      projectId: project.id,
      organizationId: project.organizationId,
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

  // Auto-revalidate every 5 seconds to get fresh concurrency data
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
            </Property.Table>
          </AdminDebugTooltip>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable={true}>
        <MainHorizontallyCenteredContainer>
          <div className="flex flex-col gap-8">
            {/* Plan info */}
            {data.planName && (
              <div className="flex items-center gap-2">
                <Paragraph variant="small" className="text-text-dimmed">
                  Current plan:
                </Paragraph>
                <Badge variant="small">{data.planName}</Badge>
                <Paragraph variant="extra-small" className="text-text-dimmed">
                  (Limits refresh automatically every 5 seconds)
                </Paragraph>
              </div>
            )}

            {/* Concurrency Limits Section */}
            <ConcurrencyLimitsSection limits={data.concurrencyLimits} />

            {/* Rate Limits Section */}
            <RateLimitsSection rateLimits={data.rateLimits} />

            {/* Quotas Section */}
            <QuotasSection quotas={data.quotas} batchConcurrency={data.batchConcurrency} />
          </div>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}

function ConcurrencyLimitsSection({ limits }: { limits: ConcurrencyLimitInfo[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="border-b border-grid-dimmed pb-1">
        <Header2>Concurrency Limits</Header2>
      </div>
      <Paragraph variant="small">
        Concurrency limits determine how many runs can execute at the same time in each environment.
        The current usage updates in real-time.
      </Paragraph>
      <Table variant="bright/no-hover">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Environment</TableHeaderCell>
            <TableHeaderCell alignment="right">
              <span className="flex items-center justify-end gap-x-1">
                Limit
                <InfoIconTooltip content="Maximum concurrent runs allowed in this environment" />
              </span>
            </TableHeaderCell>
            <TableHeaderCell alignment="right">
              <span className="flex items-center justify-end gap-x-1">
                Current
                <InfoIconTooltip content="Number of runs currently executing" />
              </span>
            </TableHeaderCell>
            <TableHeaderCell>Usage</TableHeaderCell>
            <TableHeaderCell alignment="right">Source</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {limits.map((limit) => (
            <ConcurrencyLimitRow key={limit.environmentId} limit={limit} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function ConcurrencyLimitRow({ limit }: { limit: ConcurrencyLimitInfo }) {
  const percentage = limit.limit > 0 ? limit.currentUsage / limit.limit : 0;
  const cappedPercentage = Math.min(percentage, 1);

  return (
    <TableRow>
      <TableCell>
        <EnvironmentCombo
          environment={{
            type: limit.environmentType,
            branchName: limit.branchName,
          }}
          className="max-w-[18ch]"
        />
      </TableCell>
      <TableCell alignment="right" className="tabular-nums font-medium">
        {formatNumber(limit.limit)}
      </TableCell>
      <TableCell alignment="right" className="tabular-nums">
        {formatNumber(limit.currentUsage)}
      </TableCell>
      <TableCell className="min-w-[120px]">
        <UsageBar percentage={cappedPercentage} />
      </TableCell>
      <TableCell alignment="right">
        <SourceBadge source={limit.source} />
      </TableCell>
    </TableRow>
  );
}

function RateLimitsSection({ rateLimits }: { rateLimits: LimitsResult["rateLimits"] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="border-b border-grid-dimmed pb-1">
        <Header2>Rate Limits</Header2>
      </div>
      <Paragraph variant="small">
        Rate limits control how many API requests can be made within a time window. These use a
        token bucket algorithm that refills tokens over time.
      </Paragraph>
      <Table variant="bright/no-hover">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Rate Limit</TableHeaderCell>
            <TableHeaderCell>Type</TableHeaderCell>
            <TableHeaderCell alignment="right">Configuration</TableHeaderCell>
            <TableHeaderCell alignment="right">Source</TableHeaderCell>
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
  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <span className="font-medium text-text-bright">{info.name}</span>
          <span className="text-xs text-text-dimmed">{info.description}</span>
        </div>
      </TableCell>
      <TableCell>
        <Badge variant="extra-small">{info.config.type}</Badge>
      </TableCell>
      <TableCell alignment="right">
        <RateLimitConfigDisplay config={info.config} />
      </TableCell>
      <TableCell alignment="right">
        <SourceBadge source={info.source} />
      </TableCell>
    </TableRow>
  );
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
}: {
  quotas: LimitsResult["quotas"];
  batchConcurrency: LimitsResult["batchConcurrency"];
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="border-b border-grid-dimmed pb-1">
        <Header2>Quotas</Header2>
      </div>
      <Paragraph variant="small">
        Quotas define the maximum resources available to your organization.
      </Paragraph>
      <Table variant="bright/no-hover">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>Quota</TableHeaderCell>
            <TableHeaderCell alignment="right">Limit</TableHeaderCell>
            <TableHeaderCell alignment="right">Current</TableHeaderCell>
            <TableHeaderCell alignment="right">Source</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          <QuotaRow quota={quotas.projects} />
          {quotas.schedules && <QuotaRow quota={quotas.schedules} />}
          <TableRow>
            <TableCell>
              <div className="flex flex-col">
                <span className="font-medium text-text-bright">Batch Processing Concurrency</span>
                <span className="text-xs text-text-dimmed">
                  Concurrent batch items being processed
                </span>
              </div>
            </TableCell>
            <TableCell alignment="right" className="tabular-nums font-medium">
              {formatNumber(batchConcurrency.limit)}
            </TableCell>
            <TableCell alignment="right" className="tabular-nums text-text-dimmed">
              –
            </TableCell>
            <TableCell alignment="right">
              <SourceBadge source={batchConcurrency.source} />
            </TableCell>
          </TableRow>
          {quotas.devQueueSize.limit !== null && <QuotaRow quota={quotas.devQueueSize} />}
          {quotas.deployedQueueSize.limit !== null && (
            <QuotaRow quota={quotas.deployedQueueSize} />
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function QuotaRow({ quota }: { quota: QuotaInfo }) {
  const percentage = quota.limit && quota.limit > 0 ? quota.currentUsage / quota.limit : 0;
  const isAtLimit = percentage >= 1;

  return (
    <TableRow>
      <TableCell>
        <div className="flex flex-col">
          <span className="font-medium text-text-bright">{quota.name}</span>
          <span className="text-xs text-text-dimmed">{quota.description}</span>
        </div>
      </TableCell>
      <TableCell alignment="right" className="tabular-nums font-medium">
        {quota.limit !== null ? formatNumber(quota.limit) : "Unlimited"}
      </TableCell>
      <TableCell
        alignment="right"
        className={cn("tabular-nums", isAtLimit ? "text-error" : "text-text-bright")}
      >
        {formatNumber(quota.currentUsage)}
      </TableCell>
      <TableCell alignment="right">
        <SourceBadge source={quota.source} />
      </TableCell>
    </TableRow>
  );
}

function UsageBar({ percentage }: { percentage: number }) {
  const widthProgress = useMotionValue(percentage * 100);
  const color = useTransform(
    widthProgress,
    [0, 74, 75, 95, 100],
    ["#22C55E", "#22C55E", "#F59E0B", "#F43F5E", "#F43F5E"]
  );

  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-20 rounded-full bg-charcoal-700">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: percentage * 100 + "%" }}
          style={{ backgroundColor: color }}
          transition={{ duration: 0.5, type: "spring" }}
          className="absolute left-0 top-0 h-full rounded-full"
        />
      </div>
      <span className="text-xs tabular-nums text-text-dimmed">
        {Math.round(percentage * 100)}%
      </span>
    </div>
  );
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

