import { ArrowsRightLeftIcon } from "@heroicons/react/20/solid";
import { type MetaFunction } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { Badge } from "~/components/primitives/Badge";
import { LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
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
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import { InlineCode } from "~/components/code/InlineCode";
import { MetricWidget } from "~/routes/resources.metric";
import type { QueryWidgetConfig } from "~/components/metrics/QueryWidget";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { ModelRegistryPresenter } from "~/presenters/v3/ModelRegistryPresenter.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { requireUserId } from "~/services/session.server";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { useEnvironment } from "~/hooks/useEnvironment";
import {
  EnvironmentParamSchema,
  v3ModelComparePath,
  v3ModelsPath,
} from "~/utils/pathBuilder";
import {
  formatModelPrice,
  formatTokenCount,
  formatModelCost,
  formatFeature,
  formatProviderName,
} from "~/utils/modelFormatters";

const ParamSchema = EnvironmentParamSchema.extend({
  modelId: z.string(),
});

export const meta: MetaFunction = () => {
  return [{ title: "Model Detail | Trigger.dev" }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam, modelId } = ParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const presenter = new ModelRegistryPresenter(clickhouseClient);
  const model = await presenter.getModelDetail(modelId);

  if (!model) {
    throw new Response("Model not found", { status: 404 });
  }

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const userMetrics = await presenter.getUserMetrics(
    model.modelName,
    project.id,
    environment.id,
    sevenDaysAgo,
    now
  );

  return typedjson({
    model,
    userMetrics,
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
  });
};

/** Escape a value for safe interpolation into a TSQL single-quoted string. */
function escapeTSQL(value: string): string {
  return value.replace(/'/g, "''");
}

function bignumberConfig(column: string, opts?: { aggregation?: "sum" | "avg" | "first"; suffix?: string; abbreviate?: boolean }): QueryWidgetConfig {
  return { type: "bignumber", column, aggregation: opts?.aggregation ?? "sum", abbreviate: opts?.abbreviate ?? false, suffix: opts?.suffix };
}

function chartConfig(opts: { chartType: "bar" | "line"; xAxisColumn: string; yAxisColumns: string[]; aggregation?: "sum" | "avg" }): QueryWidgetConfig {
  return { type: "chart", chartType: opts.chartType, xAxisColumn: opts.xAxisColumn, yAxisColumns: opts.yAxisColumns, groupByColumn: null, stacked: false, sortByColumn: null, sortDirection: "asc", aggregation: opts.aggregation ?? "sum" };
}

type Tab = "overview" | "global" | "usage";

const TAB_CONFIG: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "usage", label: "Metrics" },
  { id: "global", label: "Global metrics" },
];

export default function ModelDetailPage() {
  const { model, userMetrics, organizationId, projectId, environmentId } =
    useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  return (
    <PageContainer>
      <NavBar>
        <PageTitle
          title={model.displayId}
          backButton={{
            to: v3ModelsPath(organization, project, environment),
            text: "Models",
          }}
        />
        <PageAccessories>
          <LinkButton
            variant="tertiary/small"
            to={`${v3ModelComparePath(organization, project, environment)}?models=${model.modelName}`}
            LeadingIcon={ArrowsRightLeftIcon}
          >
            Compare with...
          </LinkButton>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable>
        <TabContainer>
          {TAB_CONFIG.map((tab) => (
            <TabButton
              key={tab.id}
              isActive={activeTab === tab.id}
              layoutId="model-detail-tabs"
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </TabButton>
          ))}
        </TabContainer>

        <div className="p-4">
          {activeTab === "overview" && <OverviewTab model={model} userMetrics={userMetrics} />}
          {activeTab === "global" && (
            <GlobalMetricsTab
              modelName={model.modelName}
              organizationId={organizationId}
              projectId={projectId}
              environmentId={environmentId}
            />
          )}
          {activeTab === "usage" && (
            <YourUsageTab
              modelName={model.modelName}
              organizationId={organizationId}
              projectId={projectId}
              environmentId={environmentId}
            />
          )}
        </div>
      </PageBody>
    </PageContainer>
  );
}

// --- Cost Estimator ---

function CostEstimator({
  inputPrice,
  outputPrice,
  defaultInputTokens,
  defaultOutputTokens,
}: {
  inputPrice: number | null;
  outputPrice: number | null;
  defaultInputTokens?: number;
  defaultOutputTokens?: number;
}) {
  const [inputTokens, setInputTokens] = useState(defaultInputTokens ?? 1000);
  const [outputTokens, setOutputTokens] = useState(defaultOutputTokens ?? 500);
  const [numCalls, setNumCalls] = useState(1000);

  if (inputPrice === null && outputPrice === null) return null;

  const inputCost = inputTokens * (inputPrice ?? 0) * numCalls;
  const outputCost = outputTokens * (outputPrice ?? 0) * numCalls;
  const totalCost = inputCost + outputCost;

  return (
    <div className="rounded-md border border-grid-dimmed p-4">
      <Header2 className="mb-3">Cost Estimator</Header2>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="input-tokens">Input tokens/call</Label>
            <Input
              id="input-tokens"
              variant="medium"
              fullWidth
              type="number"
              value={inputTokens}
              onChange={(e) => setInputTokens(parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="output-tokens">Output tokens/call</Label>
            <Input
              id="output-tokens"
              variant="medium"
              fullWidth
              type="number"
              value={outputTokens}
              onChange={(e) => setOutputTokens(parseInt(e.target.value) || 0)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="num-calls">Number of calls</Label>
            <Input
              id="num-calls"
              variant="medium"
              fullWidth
              type="number"
              value={numCalls}
              onChange={(e) => setNumCalls(parseInt(e.target.value) || 0)}
            />
          </div>
        </div>
        <Callout variant="info">
          <div className="text-lg font-semibold tabular-nums text-text-bright">
            {formatModelCost(totalCost)}
          </div>
          <div className="mt-1 space-y-0.5 text-xs tabular-nums text-text-dimmed">
            <div>
              Input: {formatModelCost(inputCost)} ({formatTokenCount(inputTokens * numCalls)}{" "}
              tokens x {formatModelPrice(inputPrice)}/1M)
            </div>
            <div>
              Output: {formatModelCost(outputCost)} ({formatTokenCount(outputTokens * numCalls)}{" "}
              tokens x {formatModelPrice(outputPrice)}/1M)
            </div>
          </div>
        </Callout>
      </div>
    </div>
  );
}

// --- Overview Tab ---

function OverviewTab({
  model,
  userMetrics,
}: {
  model: ReturnType<typeof useTypedLoaderData<typeof loader>>["model"];
  userMetrics: ReturnType<typeof useTypedLoaderData<typeof loader>>["userMetrics"];
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Model Info */}
        <div className="rounded-md border border-grid-dimmed p-4">
          <Header2 className="mb-3">Model Info</Header2>
          <Property.Table>
            <Property.Item>
              <Property.Label>Provider</Property.Label>
              <Property.Value>{formatProviderName(model.provider)}</Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Model Name</Property.Label>
              <Property.Value>
                <InlineCode variant="small">{model.modelName}</InlineCode>
              </Property.Value>
            </Property.Item>
            {model.description && (
              <Property.Item>
                <Property.Label>Description</Property.Label>
                <Property.Value>{model.description}</Property.Value>
              </Property.Item>
            )}
            {model.contextWindow && (
              <Property.Item>
                <Property.Label>Context Window</Property.Label>
                <Property.Value>
                  {formatTokenCount(model.contextWindow)} tokens
                </Property.Value>
              </Property.Item>
            )}
            {model.maxOutputTokens && (
              <Property.Item>
                <Property.Label>Max Output</Property.Label>
                <Property.Value>
                  {formatTokenCount(model.maxOutputTokens)} tokens
                </Property.Value>
              </Property.Item>
            )}
            {model.features.length > 0 && (
              <Property.Item>
                <Property.Label>Features</Property.Label>
                <Property.Value>
                  <div className="flex flex-wrap gap-1">
                    {model.features.map((f) => (
                      <Badge key={f} variant="outline-rounded">
                        {formatFeature(f)}
                      </Badge>
                    ))}
                  </div>
                </Property.Value>
              </Property.Item>
            )}
            <Property.Item>
              <Property.Label>Match Pattern</Property.Label>
              <Property.Value>
                <InlineCode variant="small">{model.matchPattern}</InlineCode>
              </Property.Value>
            </Property.Item>
          </Property.Table>
        </div>

        {/* Pricing */}
        <div className="rounded-md border border-grid-dimmed p-4">
          <Header2 className="mb-3">Pricing</Header2>
          <Property.Table>
            <Property.Item>
              <Property.Label>Input</Property.Label>
              <Property.Value>
                {formatModelPrice(model.inputPrice)} / 1M tokens
              </Property.Value>
            </Property.Item>
            <Property.Item>
              <Property.Label>Output</Property.Label>
              <Property.Value>
                {formatModelPrice(model.outputPrice)} / 1M tokens
              </Property.Value>
            </Property.Item>
          </Property.Table>
          {model.pricingTiers.length > 1 && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium text-text-dimmed">All pricing tiers</p>
              {model.pricingTiers.map((tier) => (
                <div
                  key={tier.name}
                  className="mb-2 rounded border border-grid-dimmed p-2 text-xs"
                >
                  <span className="font-medium text-text-bright">{tier.name}</span>
                  {tier.isDefault && (
                    <Badge variant="outline-rounded" className="ml-2">
                      default
                    </Badge>
                  )}
                  <div className="mt-1 space-y-0.5 text-text-dimmed">
                    {Object.entries(tier.prices).map(([usage, price]) => (
                      <div key={usage}>
                        {usage}: ${(price * 1_000_000).toFixed(4)} / 1M
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Cost Estimator */}
      <CostEstimator
        inputPrice={model.inputPrice}
        outputPrice={model.outputPrice}
        defaultInputTokens={
          userMetrics.totalCalls > 0
            ? Math.round(userMetrics.totalInputTokens / userMetrics.totalCalls)
            : undefined
        }
        defaultOutputTokens={
          userMetrics.totalCalls > 0
            ? Math.round(userMetrics.totalOutputTokens / userMetrics.totalCalls)
            : undefined
        }
      />
    </div>
  );
}

// --- Global Metrics Tab ---

function GlobalMetricsTab({
  modelName,
  organizationId,
  projectId,
  environmentId,
}: {
  modelName: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
}) {
  const widgetProps = {
    organizationId,
    projectId,
    environmentId,
    scope: "environment" as const,
    period: "7d",
    from: null,
    to: null,
  };

  return (
    <div className="space-y-4">
      {/* Big numbers */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="h-24">
          <MetricWidget
            widgetKey={`${modelName}-ttfc-p50`}
            title="p50 TTFC"
            query={`SELECT round(quantilesMerge(0.5)(ttfc_quantiles)[1], 0) AS ttfc_p50 FROM llm_models WHERE response_model = '${escapeTSQL(modelName)}'`}
            config={bignumberConfig("ttfc_p50", { aggregation: "avg", suffix: "ms" })}
            {...widgetProps}
          />
        </div>
        <div className="h-24">
          <MetricWidget
            widgetKey={`${modelName}-ttfc-p90`}
            title="p90 TTFC"
            query={`SELECT round(quantilesMerge(0.9)(ttfc_quantiles)[1], 0) AS ttfc_p90 FROM llm_models WHERE response_model = '${escapeTSQL(modelName)}'`}
            config={bignumberConfig("ttfc_p90", { aggregation: "avg", suffix: "ms" })}
            {...widgetProps}
          />
        </div>
        <div className="h-24">
          <MetricWidget
            widgetKey={`${modelName}-tps`}
            title="Tokens/sec (p50)"
            query={`SELECT round(quantilesMerge(0.5)(tps_quantiles)[1], 0) AS tps_p50 FROM llm_models WHERE response_model = '${escapeTSQL(modelName)}'`}
            config={bignumberConfig("tps_p50", { aggregation: "avg" })}
            {...widgetProps}
          />
        </div>
      </div>

      {/* Charts */}
      <div className="h-[300px]">
        <MetricWidget
          widgetKey={`${modelName}-ttfc-time`}
          title="TTFC over time"
          query={`SELECT timeBucket(), round(quantilesMerge(0.5)(ttfc_quantiles)[1], 0) AS ttfc_p50, round(quantilesMerge(0.9)(ttfc_quantiles)[1], 0) AS ttfc_p90 FROM llm_models WHERE response_model = '${escapeTSQL(modelName)}' GROUP BY timeBucket ORDER BY timeBucket`}
          config={chartConfig({ chartType: "line", xAxisColumn: "timebucket", yAxisColumns: ["ttfc_p50", "ttfc_p90"], aggregation: "avg" })}
          {...widgetProps}
        />
      </div>

      <Callout variant="info">
        Aggregated across all Trigger.dev users. No tenant-specific data is exposed.
      </Callout>
    </div>
  );
}

// --- Your Usage Tab ---

function YourUsageTab({
  modelName,
  organizationId,
  projectId,
  environmentId,
}: {
  modelName: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
}) {
  const widgetProps = {
    organizationId,
    projectId,
    environmentId,
    scope: "environment" as const,
    period: "7d",
    from: null,
    to: null,
  };

  return (
    <div className="space-y-4">
      {/* Big numbers */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="h-24">
          <MetricWidget
            widgetKey={`${modelName}-user-calls`}
            title="Total calls (7d)"
            query={`SELECT count() AS total_calls FROM llm_metrics WHERE response_model = '${escapeTSQL(modelName)}'`}
            config={bignumberConfig("total_calls", { abbreviate: true })}
            {...widgetProps}
          />
        </div>
        <div className="h-24">
          <MetricWidget
            widgetKey={`${modelName}-user-cost`}
            title="Total cost (7d)"
            query={`SELECT sum(total_cost) AS total_cost FROM llm_metrics WHERE response_model = '${escapeTSQL(modelName)}'`}
            config={bignumberConfig("total_cost", { aggregation: "sum" })}
            {...widgetProps}
          />
        </div>
        <div className="h-24">
          <MetricWidget
            widgetKey={`${modelName}-user-ttfc`}
            title="Avg TTFC"
            query={`SELECT round(avg(ms_to_first_chunk), 0) AS avg_ttfc FROM llm_metrics WHERE response_model = '${escapeTSQL(modelName)}' AND ms_to_first_chunk > 0`}
            config={bignumberConfig("avg_ttfc", { aggregation: "avg", suffix: "ms" })}
            {...widgetProps}
          />
        </div>
        <div className="h-24">
          <MetricWidget
            widgetKey={`${modelName}-user-tps`}
            title="Avg Tokens/sec"
            query={`SELECT round(avg(tokens_per_second), 0) AS avg_tps FROM llm_metrics WHERE response_model = '${escapeTSQL(modelName)}' AND tokens_per_second > 0`}
            config={bignumberConfig("avg_tps", { aggregation: "avg" })}
            {...widgetProps}
          />
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div className="h-[300px]">
          <MetricWidget
            widgetKey={`${modelName}-user-cost-time`}
            title="Cost over time"
            query={`SELECT timeBucket(), sum(total_cost) AS cost FROM llm_metrics WHERE response_model = '${escapeTSQL(modelName)}' GROUP BY timeBucket ORDER BY timeBucket`}
            config={chartConfig({ chartType: "bar", xAxisColumn: "timebucket", yAxisColumns: ["cost"] })}
            {...widgetProps}
          />
        </div>
        <div className="h-[300px]">
          <MetricWidget
            widgetKey={`${modelName}-user-tokens-time`}
            title="Tokens over time"
            query={`SELECT timeBucket(), sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens FROM llm_metrics WHERE response_model = '${escapeTSQL(modelName)}' GROUP BY timeBucket ORDER BY timeBucket`}
            config={chartConfig({ chartType: "bar", xAxisColumn: "timebucket", yAxisColumns: ["input_tokens", "output_tokens"] })}
            {...widgetProps}
          />
        </div>
      </div>

      {/* Task breakdown */}
      <div className="h-[300px]">
        <MetricWidget
          widgetKey={`${modelName}-user-tasks`}
          title="Cost by task"
          query={`SELECT task_identifier, count() AS calls, sum(total_cost) AS cost FROM llm_metrics WHERE response_model = '${escapeTSQL(modelName)}' GROUP BY task_identifier ORDER BY cost DESC LIMIT 20`}
          config={{ type: "table", prettyFormatting: true, sorting: [] }}
          {...widgetProps}
        />
      </div>
    </div>
  );
}
