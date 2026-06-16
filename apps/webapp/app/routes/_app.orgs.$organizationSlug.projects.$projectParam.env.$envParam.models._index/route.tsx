import {
  AdjustmentsHorizontalIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  CubeIcon,
  XMarkIcon,
} from "@heroicons/react/20/solid";
import * as Ariakit from "@ariakit/react";
import {
  Form,
  type MetaFunction,
  type ShouldRevalidateFunctionArgs,
  useFetcher,
} from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import {
  AnthropicIcon,
  AzureIcon,
  CerebrasIcon,
  DeepseekIcon,
  GeminiIcon,
  LlamaIcon,
  MistralIcon,
  OpenAIIcon,
  PerplexityIcon,
  XAIIcon,
} from "~/assets/icons/AiProviderIcons";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { InlineCode } from "~/components/code/InlineCode";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Badge } from "~/components/primitives/Badge";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Checkbox } from "~/components/primitives/Checkbox";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/primitives/Dialog";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import * as Property from "~/components/primitives/PropertyTable";
import {
  RESIZABLE_PANEL_ANIMATION,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  collapsibleHandleClassName,
  useFrozenValue,
} from "~/components/primitives/Resizable";
import { SearchInput } from "~/components/primitives/SearchInput";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { Switch } from "~/components/primitives/Switch";
import {
  SelectProvider,
  SelectPopover,
  SelectList,
  SelectItem,
} from "~/components/primitives/Select";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { TabButton, TabContainer } from "~/components/primitives/Tabs";
import {
  appliedSummary,
  TimeFilter,
  type TimeFilterApplyValues,
  timeFilterFromTo,
} from "~/components/runs/v3/SharedFilters";
import { parseFiniteInt } from "~/utils/searchParams";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useShortcutKeys } from "~/hooks/useShortcutKeys";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type ModelCatalogItem,
  type ModelComparisonItem,
  type PopularModel,
  type ProjectModelUsageItem,
  ModelRegistryPresenter,
} from "~/presenters/v3/ModelRegistryPresenter.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { requireUserId } from "~/services/session.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { EnvironmentParamSchema, v3BuiltInDashboardPath, v3ModelComparePath } from "~/utils/pathBuilder";
import {
  formatModelPrice,
  formatTokenCount,
  formatFeature,
  formatProviderName,
  formatModelCost,
} from "~/utils/modelFormatters";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { Spinner } from "~/components/primitives/Spinner";
import { UsageSparkline } from "~/components/primitives/UsageSparkline";
import { MetricWidget } from "~/routes/resources.metric";
import type { QueryWidgetConfig } from "~/components/metrics/QueryWidget";

import { type loader as compareLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.models.compare/route";
import { IconColumns3 } from "@tabler/icons-react";

export const meta: MetaFunction = () => {
  return [{ title: "Models | Trigger.dev" }];
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(project.organizationId, "standard");
  const presenter = new ModelRegistryPresenter(clickhouse);
  const catalog = await presenter.getModelCatalog();

  // Shared time range for the "Your models" tab (charts, usage table, sparklines).
  // Mirrors the agent detail page: URL-driven period / from / to via TimeFilter.
  const url = new URL(request.url);
  const period = url.searchParams.get("period") ?? undefined;
  const from = parseFiniteInt(url.searchParams.get("from"));
  const to = parseFiniteInt(url.searchParams.get("to"));
  const time = timeFilterFromTo({ period, from, to, defaultPeriod: "7d" });

  // popularModels powers the library tab's cross-tenant p50 TTFC column — a
  // stable "typical latency" reference, so it always uses a fixed 7-day window
  // independent of the Your models time selector (the library tab has none).
  const popularTo = new Date();
  const popularFrom = new Date(popularTo.getTime() - 7 * 24 * 60 * 60 * 1000);

  // projectUsage = tenant-scoped models with usage in this env (the "Your models" tab).
  const [popularModels, projectUsage] = await Promise.all([
    presenter.getPopularModels(popularFrom, popularTo, 50),
    presenter.getProjectModelUsage(project.id, environment.id, time.from, time.to),
  ]);

  const usageSparklines = await presenter.getModelUsageSparklines(
    environment.id,
    projectUsage.map((u) => u.responseModel),
    time.from,
    time.to
  );

  const allProviders = catalog.map((g) => g.provider);
  const allFeatures = Array.from(
    new Set(catalog.flatMap((g) => g.models.flatMap((m) => m.features)))
  ).sort();

  return typedjson({
    catalog,
    popularModels,
    projectUsage,
    usageSparklines,
    allProviders,
    allFeatures,
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
  });
};

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  // The active tab is persisted in the URL (?tab=), but no loader data depends
  // on it — so switching tabs must not refetch. Any other change (a different
  // project/environment in the path, or a period/from/to param) revalidates as
  // normal, since the loader data is scoped to the path params + time range.
  const normalize = (url: URL) => {
    const params = new URLSearchParams(url.search);
    params.delete("tab");
    params.sort();
    return params.toString();
  };
  if (
    currentUrl.pathname === nextUrl.pathname &&
    normalize(currentUrl) === normalize(nextUrl)
  ) {
    return false;
  }
  return defaultShouldRevalidate;
}

const providerIcons: Record<string, (props: { className?: string }) => JSX.Element> = {
  openai: OpenAIIcon,
  anthropic: AnthropicIcon,
  google: GeminiIcon,
  meta: LlamaIcon,
  mistral: MistralIcon,
  deepseek: DeepseekIcon,
  xai: XAIIcon,
  perplexity: PerplexityIcon,
  cerebras: CerebrasIcon,
  azure: AzureIcon,
};

function providerIcon(slug: string) {
  const Icon = providerIcons[slug] ?? CubeIcon;
  return <Icon className="size-4 text-text-dimmed" />;
}

const NEW_MODEL_WINDOW_DAYS = 7;

/** True if the model was released within the last NEW_MODEL_WINDOW_DAYS. */
function isNewModel(releaseDate: string | null): boolean {
  if (!releaseDate) return false;
  const released = new Date(releaseDate).getTime();
  if (Number.isNaN(released)) return false;
  return Date.now() - released <= NEW_MODEL_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

// --- Filter Components ---

const providerShortcut = { key: "p" };

function ProviderFilter({ providers }: { providers: string[] }) {
  const { values, replace, del } = useSearchParams();
  const selected = values("providers");
  const hasFilter = selected.length > 0;
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: providerShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <SelectProvider value={selected} setValue={(v) => replace({ providers: v })}>
      <Ariakit.TooltipProvider timeout={200} hideTimeout={0}>
        <Ariakit.TooltipAnchor
          render={
            <Ariakit.Select
              ref={triggerRef as any}
              render={<div className="group cursor-pointer focus-custom" />}
            />
          }
        >
          <AppliedFilter
            icon={<CubeIcon className="size-4" />}
            label={hasFilter ? "Provider" : undefined}
            value={hasFilter ? appliedSummary(selected.map(formatProviderName))! : "Provider"}
            valueClassName={hasFilter ? undefined : "text-text-bright"}
            removable={hasFilter}
            onRemove={() => del("providers")}
          />
        </Ariakit.TooltipAnchor>
        <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright py-1.5 pl-2.5 pr-3 text-xs text-text-dimmed">
          <div className="flex items-center gap-3">
            <span>Filter by provider</span>
            <ShortcutKey className="size-4 flex-none" shortcut={providerShortcut} variant="small" />
          </div>
        </Ariakit.Tooltip>
      </Ariakit.TooltipProvider>
      <SelectPopover>
        <SelectList>
          {providers.map((p) => (
            <SelectItem key={p} value={p} icon={providerIcon(p)} className="text-text-bright">
              {formatProviderName(p)}
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

const featuresShortcut = { key: "f" };

function FeaturesFilter({ features }: { features: string[] }) {
  const { values, replace, del } = useSearchParams();
  const selected = values("features");
  const hasFilter = selected.length > 0;
  const triggerRef = useRef<HTMLButtonElement>(null);

  useShortcutKeys({
    shortcut: featuresShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      triggerRef.current?.click();
    },
  });

  return (
    <SelectProvider value={selected} setValue={(v) => replace({ features: v })}>
      <Ariakit.TooltipProvider timeout={200} hideTimeout={0}>
        <Ariakit.TooltipAnchor
          render={
            <Ariakit.Select
              ref={triggerRef as any}
              render={<div className="group cursor-pointer focus-custom" />}
            />
          }
        >
          <AppliedFilter
            icon={<AdjustmentsHorizontalIcon className="size-4" />}
            label={hasFilter ? "Features" : undefined}
            value={hasFilter ? appliedSummary(selected.map(formatFeature))! : "Features"}
            valueClassName={hasFilter ? undefined : "text-text-bright"}
            removable={hasFilter}
            onRemove={() => del("features")}
          />
        </Ariakit.TooltipAnchor>
        <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright py-1.5 pl-2.5 pr-3 text-xs text-text-dimmed">
          <div className="flex items-center gap-3">
            <span>Filter by features</span>
            <ShortcutKey className="size-4 flex-none" shortcut={featuresShortcut} variant="small" />
          </div>
        </Ariakit.Tooltip>
      </Ariakit.TooltipProvider>
      <SelectPopover>
        <SelectList>
          {features.map((f) => (
            <SelectItem key={f} value={f} className="text-text-bright">
              {formatFeature(f)}
            </SelectItem>
          ))}
        </SelectList>
      </SelectPopover>
    </SelectProvider>
  );
}

// --- Filters Bar ---

function FiltersBar({
  allProviders,
  allFeatures,
  compareSet,
  onCompare,
  showAllDetails,
  onToggleAllDetails,
}: {
  allProviders: string[];
  allFeatures: string[];
  compareSet: Set<string>;
  onCompare: () => void;
  showAllDetails: boolean;
  onToggleAllDetails: (checked: boolean) => void;
}) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("providers") || searchParams.has("features") || searchParams.has("search");

  const compareDisabled = compareSet.size < 2;
  const compareShortcut = { key: "c" };
  const detailsShortcut = { key: "d" };

  useShortcutKeys({
    shortcut: compareShortcut,
    action: (e) => {
      e.preventDefault();
      e.stopPropagation();
      onCompare();
    },
    disabled: compareDisabled,
  });

  return (
    <div className="flex items-start justify-between gap-x-2 border-b border-grid-bright p-2">
      <div className="flex flex-row flex-wrap items-center gap-1.5">
        <SearchInput placeholder="Search models…" />
        <ProviderFilter providers={allProviders} />
        <FeaturesFilter features={allFeatures} />
        {hasFilters && (
          <Form className="-ml-1 h-6">
            <Button
              variant="minimal/small"
              LeadingIcon={XMarkIcon}
              tooltip="Clear all filters"
              className="group-hover/button:bg-transparent"
              leadingIconClassName="group-hover/button:text-text-bright"
            />
          </Form>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5">
        <Button
          variant="secondary/small"
          disabled={compareDisabled}
          className="pl-1 pr-1.5"
          tooltip={
            compareDisabled ? (
              <span className="text-text-dimmed">Choose 2–4 models to compare</span>
            ) : (
              <span className="flex items-center gap-3 text-text-dimmed">
                Compare selected models
                <ShortcutKey
                  className="size-4 flex-none"
                  shortcut={compareShortcut}
                  variant="small"
                />
              </span>
            )
          }
          onClick={compareDisabled ? undefined : onCompare}
          LeadingIcon={IconColumns3}
          leadingIconClassName="-mr-2"
        >
          <span className="flex items-center overflow-hidden">
            <span className={!compareDisabled ? "text-text-bright" : undefined}>Compare</span>
            <AnimatePresence initial={false}>
              {compareSet.size >= 2 && (
                <motion.span
                  key="badge"
                  initial={{ width: 0, marginLeft: 0, opacity: 0 }}
                  animate={{ width: "auto", marginLeft: 4, opacity: 1 }}
                  exit={{ width: 0, marginLeft: 0, opacity: 0 }}
                  transition={{ duration: 0.15, ease: "easeInOut" }}
                  className="inline-flex"
                >
                  <Badge variant="rounded">{compareSet.size}</Badge>
                </motion.span>
              )}
            </AnimatePresence>
          </span>
        </Button>
        <Ariakit.TooltipProvider timeout={200} hideTimeout={0}>
          <Ariakit.TooltipAnchor render={<div />}>
            <Switch
              variant="secondary/small"
              label="All details"
              checked={showAllDetails}
              onCheckedChange={onToggleAllDetails}
              shortcut={detailsShortcut}
            />
          </Ariakit.TooltipAnchor>
          <Ariakit.Tooltip className="z-40 cursor-default rounded border border-charcoal-700 bg-background-bright py-1.5 pl-2.5 pr-3 text-xs text-text-dimmed">
            <div className="flex items-center gap-3">
              <span>Toggle all details</span>
              <ShortcutKey
                className="size-4 flex-none"
                shortcut={detailsShortcut}
                variant="small"
              />
            </div>
          </Ariakit.Tooltip>
        </Ariakit.TooltipProvider>
      </div>
    </div>
  );
}

// --- Models Table ---

function BooleanCell({ value, onClick }: { value: boolean; onClick: () => void }) {
  return (
    <TableCell onClick={onClick} alignment="center">
      {value ? (
        <CheckIcon className="size-4 text-text-dimmed group-hover/table-row:text-text-bright" />
      ) : null}
    </TableCell>
  );
}

function ModelsList({
  models,
  popularMap,
  compareSet,
  onToggleCompare,
  showAllDetails,
  allFeatures,
  selectedModelId,
  onSelectModel,
}: {
  models: ModelCatalogItem[];
  popularMap: Map<string, PopularModel>;
  compareSet: Set<string>;
  onToggleCompare: (modelName: string) => void;
  showAllDetails: boolean;
  allFeatures: string[];
  selectedModelId: string | null;
  onSelectModel: (model: ModelCatalogItem) => void;
}) {
  if (models.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-center text-sm text-text-dimmed">No models match your filters.</p>
      </div>
    );
  }

  return (
    <Table containerClassName="max-h-full" showTopBorder={false}>
      <TableHeader>
        <TableRow>
          <TableHeaderCell className="w-8" />
          <TableHeaderCell>Model</TableHeaderCell>
          <TableHeaderCell>Provider</TableHeaderCell>
          <TableHeaderCell alignment="right">Input $/1M</TableHeaderCell>
          <TableHeaderCell alignment="right">Output $/1M</TableHeaderCell>
          <TableHeaderCell alignment="right">Context</TableHeaderCell>
          {showAllDetails && (
            <>
              <TableHeaderCell alignment="right">Max output</TableHeaderCell>
              <TableHeaderCell>Release date</TableHeaderCell>
              {allFeatures.map((f) => (
                <TableHeaderCell key={f} alignment="center">
                  {formatFeature(f)}
                </TableHeaderCell>
              ))}
            </>
          )}
          <TableHeaderCell alignment="right">p50 TTFC</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((model) => {
          const popular = popularMap.get(model.modelName);
          const select = () => onSelectModel(model);
          return (
            <TableRow key={model.friendlyId} isSelected={selectedModelId === model.friendlyId}>
              <TableCell>
                <Checkbox
                  checked={compareSet.has(model.modelName)}
                  onChange={() => onToggleCompare(model.modelName)}
                  disabled={compareSet.size >= 4 && !compareSet.has(model.modelName)}
                />
              </TableCell>
              <TableCell onClick={select} isTabbableCell>
                <span className="flex items-center gap-2">
                  {model.displayId}
                  {isNewModel(model.releaseDate) && <Badge variant="outline-rounded">New</Badge>}
                </span>
              </TableCell>
              <TableCell onClick={select}>
                <span className="flex items-center gap-1.5">
                  {providerIcon(model.provider)}
                  {formatProviderName(model.provider)}
                </span>
              </TableCell>
              <TableCell onClick={select} alignment="right" className="tabular-nums">
                {formatModelPrice(model.inputPrice)}
              </TableCell>
              <TableCell onClick={select} alignment="right" className="tabular-nums">
                {formatModelPrice(model.outputPrice)}
              </TableCell>
              <TableCell onClick={select} alignment="right" className="tabular-nums">
                {formatTokenCount(model.contextWindow)}
              </TableCell>
              {showAllDetails && (
                <>
                  <TableCell onClick={select} alignment="right" className="tabular-nums">
                    {formatTokenCount(model.maxOutputTokens)}
                  </TableCell>
                  <TableCell onClick={select}>
                    {model.releaseDate ? (
                      <DateTime date={model.releaseDate} includeTime={false} />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  {allFeatures.map((f) => (
                    <BooleanCell key={f} value={model.features.includes(f)} onClick={select} />
                  ))}
                </>
              )}
              <TableCell onClick={select} alignment="right" className="tabular-nums">
                {popular && popular.ttfcP50 > 0 ? `${popular.ttfcP50.toFixed(0)}ms` : "—"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// --- Compare Dialog ---

type ComparisonRow = {
  label: string;
  values: React.ReactNode[];
  bestIndex?: number;
};

function buildComparisonRows(
  models: string[],
  catalogModels: ModelCatalogItem[],
  comparison: ModelComparisonItem[]
): ComparisonRow[] {
  const catalogMap = new Map<string, ModelCatalogItem>();
  for (const item of catalogModels) {
    catalogMap.set(item.modelName, item);
  }

  const dataMap = new Map<string, ModelComparisonItem>();
  for (const item of comparison) {
    dataMap.set(item.responseModel, item);
  }

  const allFeatures = Array.from(
    new Set(models.flatMap((m) => catalogMap.get(m)?.features ?? []))
  ).sort();

  const getCatalog = (model: string) => catalogMap.get(model);
  const getMetric = (model: string, key: keyof ModelComparisonItem) => {
    const d = dataMap.get(model);
    return d ? d[key] : 0;
  };

  const findBest = (values: number[], lowerIsBetter: boolean) => {
    if (values.every((v) => v === 0)) return undefined;
    const filtered = values.map((v, i) => ({ v, i })).filter(({ v }) => v > 0);
    if (filtered.length === 0) return undefined;
    const best = lowerIsBetter
      ? filtered.reduce((a, b) => (a.v < b.v ? a : b))
      : filtered.reduce((a, b) => (a.v > b.v ? a : b));
    return best.i;
  };

  const inputPrices = models.map((m) => getCatalog(m)?.inputPrice ?? 0);
  const outputPrices = models.map((m) => getCatalog(m)?.outputPrice ?? 0);
  const contextWindows = models.map((m) => getCatalog(m)?.contextWindow ?? 0);
  const maxOutputs = models.map((m) => getCatalog(m)?.maxOutputTokens ?? 0);
  const callValues = models.map((m) => Number(getMetric(m, "callCount")));
  const ttfcP50Values = models.map((m) => Number(getMetric(m, "ttfcP50")));
  const ttfcP90Values = models.map((m) => Number(getMetric(m, "ttfcP90")));
  const tpsP50Values = models.map((m) => Number(getMetric(m, "tpsP50")));
  const tpsP90Values = models.map((m) => Number(getMetric(m, "tpsP90")));
  const costValues = models.map((m) => Number(getMetric(m, "totalCost")));

  return [
    {
      label: "Provider",
      values: models.map((m) => {
        const c = getCatalog(m);
        const slug = c?.provider ?? dataMap.get(m)?.genAiSystem;
        if (!slug) return "—";
        return (
          <span className="flex items-center gap-1.5">
            {providerIcon(slug)}
            {formatProviderName(slug)}
          </span>
        );
      }),
    },
    {
      label: "Input $/1M",
      values: models.map((m) => formatModelPrice(getCatalog(m)?.inputPrice ?? null)),
      bestIndex: findBest(inputPrices, true),
    },
    {
      label: "Output $/1M",
      values: models.map((m) => formatModelPrice(getCatalog(m)?.outputPrice ?? null)),
      bestIndex: findBest(outputPrices, true),
    },
    {
      label: "Context window",
      values: models.map((m) => formatTokenCount(getCatalog(m)?.contextWindow ?? null)),
      bestIndex: findBest(contextWindows, false),
    },
    {
      label: "Max output",
      values: models.map((m) => formatTokenCount(getCatalog(m)?.maxOutputTokens ?? null)),
      bestIndex: findBest(maxOutputs, false),
    },
    {
      label: "Release date",
      values: models.map((m) => {
        const c = getCatalog(m);
        return c?.releaseDate
          ? new Date(c.releaseDate).toLocaleDateString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
            })
          : "—";
      }),
    },
    ...allFeatures.map((feature) => ({
      label: formatFeature(feature),
      values: models.map((m) =>
        getCatalog(m)?.features.includes(feature) ? (
          <CheckIcon className="size-4 text-success/70 group-hover/table-row:text-success" />
        ) : (
          "—"
        )
      ),
    })),
    {
      label: "Total calls (7d)",
      values: callValues.map((v) => formatNumberCompact(v)),
      bestIndex: findBest(callValues, false),
    },
    {
      label: "p50 TTFC",
      values: ttfcP50Values.map((v) => (v > 0 ? `${v.toFixed(0)}ms` : "—")),
      bestIndex: findBest(ttfcP50Values, true),
    },
    {
      label: "p90 TTFC",
      values: ttfcP90Values.map((v) => (v > 0 ? `${v.toFixed(0)}ms` : "—")),
      bestIndex: findBest(ttfcP90Values, true),
    },
    {
      label: "Tokens/sec (p50)",
      values: tpsP50Values.map((v) => (v > 0 ? v.toFixed(0) : "—")),
      bestIndex: findBest(tpsP50Values, false),
    },
    {
      label: "Tokens/sec (p90)",
      values: tpsP90Values.map((v) => (v > 0 ? v.toFixed(0) : "—")),
      bestIndex: findBest(tpsP90Values, false),
    },
    {
      label: "Total cost (7d)",
      values: costValues.map((v) => (v > 0 ? formatModelCost(v) : "—")),
      bestIndex: findBest(costValues, true),
    },
  ];
}

function CompareDialog({
  open,
  onOpenChange,
  models,
  catalogModels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: string[];
  catalogModels: ModelCatalogItem[];
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const fetcher = useFetcher<typeof compareLoader>();

  const comparison = (fetcher.data as { comparison?: ModelComparisonItem[] } | undefined)
    ?.comparison;
  const rows = useMemo(
    () => buildComparisonRows(models, catalogModels, comparison ?? []),
    [comparison, models, catalogModels]
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only fires on open; other deps are stable per dialog mount
  useEffect(() => {
    if (open && models.length >= 2) {
      const params = models.join(",");
      fetcher.load(`${v3ModelComparePath(organization, project, environment)}?models=${params}`);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-fit gap-[0.4375rem] !px-0 !pb-0 !pt-0 sm:!max-w-[90vw]">
        <DialogHeader className="h-11 justify-center px-4">
          <DialogTitle>Compare models</DialogTitle>
        </DialogHeader>
        {rows.length > 0 ? (
          <div className="-mt-[0.375rem] max-h-[70vh] overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600 [&_tbody_tr:last-child]:after:hidden">
            <Table stickyHeader showTopBorder={false}>
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>Metric</TableHeaderCell>
                  {models.map((model) => (
                    <TableHeaderCell key={model} alignment="right">
                      {model}
                    </TableHeaderCell>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.label}>
                    <TableCell>
                      <span className="text-xs font-medium text-text-dimmed group-hover/table-row:text-text-bright">
                        {row.label}
                      </span>
                    </TableCell>
                    {row.values.map((value, i) => (
                      <TableCell key={i} alignment="right">
                        <div
                          className={`flex items-center justify-end tabular-nums ${
                            row.bestIndex === i
                              ? "font-medium text-success/70 group-hover/table-row:text-success"
                              : "text-text-dimmed group-hover/table-row:text-text-bright"
                          }`}
                        >
                          {value}
                        </div>
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="flex items-center justify-center py-12 text-sm text-text-dimmed">
            No comparison data available for these models.
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- Model Detail Panel ---

function escapeTSQL(value: string): string {
  return value.replace(/'/g, "''");
}

function bignumberConfig(
  column: string,
  opts?: { aggregation?: "sum" | "avg" | "first"; suffix?: string; abbreviate?: boolean }
): QueryWidgetConfig {
  return {
    type: "bignumber",
    column,
    aggregation: opts?.aggregation ?? "sum",
    abbreviate: opts?.abbreviate ?? false,
    suffix: opts?.suffix,
  };
}

function chartConfig(opts: {
  chartType: "bar" | "line";
  xAxisColumn: string;
  yAxisColumns: string[];
  aggregation?: "sum" | "avg";
  stacked?: boolean;
  groupByColumn?: string | null;
}): QueryWidgetConfig {
  return {
    type: "chart",
    chartType: opts.chartType,
    xAxisColumn: opts.xAxisColumn,
    yAxisColumns: opts.yAxisColumns,
    groupByColumn: opts.groupByColumn ?? null,
    stacked: opts.stacked ?? false,
    sortByColumn: null,
    sortDirection: "asc",
    aggregation: opts.aggregation ?? "sum",
  };
}

type DetailTab = "overview" | "usage";

type ModelsTab = "yours" | "library";

function ModelDetailPanel({
  model,
  organizationId,
  projectId,
  environmentId,
  aiMetricsBasePath,
  onClose,
}: {
  model: ModelCatalogItem;
  organizationId: string;
  projectId: string;
  environmentId: string;
  aiMetricsBasePath: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<DetailTab>("overview");

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2rem_1fr] overflow-hidden bg-background-bright">
      <div className="flex items-center justify-between gap-2 overflow-x-hidden px-3 pr-2">
        <Header2 className="truncate text-text-bright">{model.displayId}</Header2>
        <Button
          onClick={onClose}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>
      <div className="h-fit overflow-x-auto whitespace-nowrap px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <TabContainer>
          <TabButton
            isActive={tab === "overview"}
            layoutId="model-detail"
            onClick={() => setTab("overview")}
            shortcut={{ key: "o" }}
          >
            Overview
          </TabButton>
          <TabButton
            isActive={tab === "usage"}
            layoutId="model-detail"
            onClick={() => setTab("usage")}
            shortcut={{ key: "u" }}
          >
            Metrics
          </TabButton>
        </TabContainer>
      </div>
      <div className="overflow-y-auto px-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        {tab === "overview" && <DetailOverviewTab model={model} />}
        {tab === "usage" && (
          <DetailYourUsageTab
            modelName={model.modelName}
            organizationId={organizationId}
            projectId={projectId}
            environmentId={environmentId}
            aiMetricsBasePath={aiMetricsBasePath}
          />
        )}
      </div>
    </div>
  );
}

function DetailOverviewTab({ model }: { model: ModelCatalogItem }) {
  return (
    <div className="flex flex-col gap-4 py-3">
      <Property.Table>
        <Property.Item>
          <Property.Label>Provider</Property.Label>
          <Property.Value>{formatProviderName(model.provider)}</Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Model name</Property.Label>
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
        <Property.Item>
          <Property.Label>Input price</Property.Label>
          <Property.Value className="tabular-nums">
            {formatModelPrice(model.inputPrice)} / 1M tokens
          </Property.Value>
        </Property.Item>
        <Property.Item>
          <Property.Label>Output price</Property.Label>
          <Property.Value className="tabular-nums">
            {formatModelPrice(model.outputPrice)} / 1M tokens
          </Property.Value>
        </Property.Item>
        {model.contextWindow && (
          <Property.Item>
            <Property.Label>Context window</Property.Label>
            <Property.Value className="tabular-nums">
              {formatTokenCount(model.contextWindow)} tokens
            </Property.Value>
          </Property.Item>
        )}
        {model.maxOutputTokens && (
          <Property.Item>
            <Property.Label>Max output tokens</Property.Label>
            <Property.Value className="tabular-nums">
              {formatTokenCount(model.maxOutputTokens)} tokens
            </Property.Value>
          </Property.Item>
        )}
        {model.releaseDate && (
          <Property.Item>
            <Property.Label>Release date</Property.Label>
            <Property.Value>
              <DateTime date={model.releaseDate} includeTime={false} />
            </Property.Value>
          </Property.Item>
        )}
      </Property.Table>

      {model.features.length > 0 && (
        <Property.Table>
          <Property.Item>
            <Property.Label>Features</Property.Label>
            <Property.Value>
              <div className="flex flex-col gap-0.5">
                {model.features.map((f) => (
                  <div key={f} className="mt-1 flex items-center gap-1">
                    <CheckIcon className="size-4 text-text-dimmed" />
                    <span className="text-text-dimmed">{formatFeature(f)}</span>
                  </div>
                ))}
              </div>
            </Property.Value>
          </Property.Item>
        </Property.Table>
      )}

      {model.variants.length > 0 && (
        <>
          <Header2>Variants</Header2>
          <Property.Table>
            {model.variants.map((v) => (
              <Property.Item key={v.friendlyId}>
                <Property.Label>{v.displayId}</Property.Label>
                <Property.Value>
                  {v.releaseDate ? <DateTime date={v.releaseDate} includeTime={false} /> : "—"}
                </Property.Value>
              </Property.Item>
            ))}
          </Property.Table>
        </>
      )}
    </div>
  );
}

function DetailYourUsageTab({
  modelName,
  organizationId,
  projectId,
  environmentId,
  aiMetricsBasePath,
}: {
  modelName: string;
  organizationId: string;
  projectId: string;
  environmentId: string;
  aiMetricsBasePath: string;
}) {
  // Inspector-local range, independent of the page-level "Your models" range.
  const [range, setRange] = useState<TimeFilterApplyValues>({ period: "7d" });

  const widgetProps = {
    organizationId,
    projectId,
    environmentId,
    scope: "environment" as const,
    period: range.from && range.to ? null : range.period ?? "7d",
    from: range.from ?? null,
    to: range.to ?? null,
  };

  // Deep-link to the AI metrics dashboard pre-filtered to this model, carrying
  // the inspector's current range so the dashboard opens on the same window.
  const dashboardParams = new URLSearchParams({ models: modelName });
  if (range.from && range.to) {
    dashboardParams.set("from", range.from);
    dashboardParams.set("to", range.to);
  } else if (range.period) {
    dashboardParams.set("period", range.period);
  }
  const aiMetricsHref = `${aiMetricsBasePath}?${dashboardParams.toString()}`;

  return (
    <div className="flex flex-col gap-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <TimeFilter
          defaultPeriod="7d"
          labelName="Period"
          period={range.period}
          from={range.from}
          to={range.to}
          onValueChange={setRange}
        />
        <LinkButton
          to={aiMetricsHref}
          variant="secondary/small"
          TrailingIcon={ArrowTopRightOnSquareIcon}
        >
          View in AI metrics
        </LinkButton>
      </div>
      <div className="h-[120px]">
        <MetricWidget
          widgetKey={`${modelName}-user-calls`}
          title="Total calls"
          query={`SELECT count() AS total_calls FROM llm_metrics WHERE response_model = '${escapeTSQL(
            modelName
          )}'`}
          config={bignumberConfig("total_calls", { abbreviate: true })}
          {...widgetProps}
        />
      </div>
      <div className="h-[120px]">
        <MetricWidget
          widgetKey={`${modelName}-user-cost`}
          title="Total cost"
          query={`SELECT sum(total_cost) AS total_cost FROM llm_metrics WHERE response_model = '${escapeTSQL(
            modelName
          )}'`}
          config={bignumberConfig("total_cost", { aggregation: "sum" })}
          {...widgetProps}
        />
      </div>
      <div className="h-[120px]">
        <MetricWidget
          widgetKey={`${modelName}-user-ttfc`}
          title="Avg TTFC"
          query={`SELECT round(avg(ms_to_first_chunk), 0) AS avg_ttfc FROM llm_metrics WHERE response_model = '${escapeTSQL(
            modelName
          )}' AND ms_to_first_chunk > 0`}
          config={bignumberConfig("avg_ttfc", { aggregation: "avg", suffix: "ms" })}
          {...widgetProps}
        />
      </div>
      <div className="h-[120px]">
        <MetricWidget
          widgetKey={`${modelName}-user-tps`}
          title="Avg tokens/sec"
          query={`SELECT round(avg(tokens_per_second), 0) AS avg_tps FROM llm_metrics WHERE response_model = '${escapeTSQL(
            modelName
          )}' AND tokens_per_second > 0`}
          config={bignumberConfig("avg_tps", { aggregation: "avg" })}
          {...widgetProps}
        />
      </div>
      <div className="h-[120px]">
        <MetricWidget
          widgetKey={`${modelName}-user-cached-tokens`}
          title="Cached tokens"
          query={`SELECT sum(cached_read_tokens) AS cached_tokens FROM llm_metrics WHERE response_model = '${escapeTSQL(
            modelName
          )}'`}
          config={bignumberConfig("cached_tokens", { aggregation: "sum", abbreviate: true })}
          {...widgetProps}
        />
      </div>

      <div className="h-[400px]">
        <MetricWidget
          widgetKey={`${modelName}-user-cost-time`}
          title="Cost over time"
          query={`SELECT timeBucket(), sum(total_cost) AS cost FROM llm_metrics WHERE response_model = '${escapeTSQL(
            modelName
          )}' GROUP BY timeBucket ORDER BY timeBucket`}
          config={chartConfig({
            chartType: "bar",
            xAxisColumn: "timebucket",
            yAxisColumns: ["cost"],
          })}
          {...widgetProps}
        />
      </div>
      <div className="h-[400px]">
        <MetricWidget
          widgetKey={`${modelName}-user-tokens-time`}
          title="Tokens over time"
          query={`SELECT timeBucket(), sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens FROM llm_metrics WHERE response_model = '${escapeTSQL(
            modelName
          )}' GROUP BY timeBucket ORDER BY timeBucket`}
          config={chartConfig({
            chartType: "bar",
            xAxisColumn: "timebucket",
            yAxisColumns: ["input_tokens", "output_tokens"],
          })}
          {...widgetProps}
        />
      </div>
      <div className="h-[400px]">
        <MetricWidget
          widgetKey={`${modelName}-user-cache-hit`}
          title="Cache hit rate over time"
          query={`SELECT timeBucket(), round(ifNull(sum(cached_read_tokens) * 100.0 / nullIf(sum(input_tokens) + sum(cached_read_tokens), 0), 0), 1) AS cache_hit_pct FROM llm_metrics WHERE response_model = '${escapeTSQL(
            modelName
          )}' GROUP BY timeBucket ORDER BY timeBucket`}
          config={chartConfig({
            chartType: "line",
            xAxisColumn: "timebucket",
            yAxisColumns: ["cache_hit_pct"],
            aggregation: "avg",
          })}
          {...widgetProps}
        />
      </div>
      <div className="h-[400px]">
        <MetricWidget
          widgetKey={`${modelName}-user-tasks`}
          title="Cost by task"
          query={`SELECT task_identifier, count() AS calls, sum(total_cost) AS cost FROM llm_metrics WHERE response_model = '${escapeTSQL(
            modelName
          )}' GROUP BY task_identifier ORDER BY cost DESC LIMIT 20`}
          config={{ type: "table", prettyFormatting: true, sorting: [] }}
          {...widgetProps}
        />
      </div>
    </div>
  );
}

// --- Your Models Tab ---

function YourModelsTab({
  usage,
  callSparklines,
  tokenSparklines,
  bucketStartMs,
  bucketIntervalMs,
  organizationId,
  projectId,
  environmentId,
  period,
  from,
  to,
  modelLookup,
  selectedModelId,
  onSelectModel,
  onGoToLibrary,
}: {
  usage: ProjectModelUsageItem[];
  callSparklines: Record<string, number[]>;
  tokenSparklines: Record<string, number[]>;
  bucketStartMs: number;
  bucketIntervalMs: number;
  organizationId: string;
  projectId: string;
  environmentId: string;
  period: string | null;
  from: string | null;
  to: string | null;
  modelLookup: Map<string, ModelCatalogItem>;
  selectedModelId: string | null;
  onSelectModel: (model: ModelCatalogItem) => void;
  onGoToLibrary: () => void;
}) {
  // Drive the charts off the same URL-selected range as the table + sparklines.
  // period and from/to are mutually exclusive (TimeFilter enforces this).
  const widgetProps = {
    organizationId,
    projectId,
    environmentId,
    scope: "environment" as const,
    period: from && to ? null : period ?? "7d",
    from,
    to,
  };

  return (
    <div className="overflow-y-auto py-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
      <div className="grid grid-cols-1 gap-3 px-3 lg:grid-cols-3">
        <div className="h-[312px]">
          <MetricWidget
            widgetKey="your-models-cost-time"
            title="Cost over time"
            query={`SELECT timeBucket(), sum(total_cost) AS cost FROM llm_metrics GROUP BY timeBucket ORDER BY timeBucket`}
            config={chartConfig({ chartType: "bar", xAxisColumn: "timebucket", yAxisColumns: ["cost"] })}
            {...widgetProps}
          />
        </div>
        <div className="h-[312px]">
          <MetricWidget
            widgetKey="your-models-tokens-time"
            title="Tokens over time"
            query={`SELECT timeBucket(), sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens FROM llm_metrics GROUP BY timeBucket ORDER BY timeBucket`}
            config={chartConfig({
              chartType: "bar",
              xAxisColumn: "timebucket",
              yAxisColumns: ["input_tokens", "output_tokens"],
              stacked: true,
            })}
            {...widgetProps}
          />
        </div>
        <div className="h-[312px]">
          <MetricWidget
            widgetKey="your-models-calls-over-time"
            title="Calls over time"
            query={`SELECT timeBucket(), count() AS calls FROM llm_metrics GROUP BY timeBucket ORDER BY timeBucket`}
            config={chartConfig({ chartType: "bar", xAxisColumn: "timebucket", yAxisColumns: ["calls"] })}
            {...widgetProps}
          />
        </div>
      </div>

      <div className="mt-4">
        {usage.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12">
            <p className="max-w-md text-center text-sm text-text-dimmed">
              No model usage in this environment yet. Models you call from your tasks will appear here
              with usage metrics.
            </p>
            <Button variant="secondary/small" onClick={onGoToLibrary}>
              Browse the model library
            </Button>
          </div>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHeaderCell className="w-[18%]">Model</TableHeaderCell>
                <TableHeaderCell className="w-[12%]">Provider</TableHeaderCell>
                <TableHeaderCell className="w-[8%]" alignment="right">
                  Calls
                </TableHeaderCell>
                <TableHeaderCell className="w-[8%]" alignment="right">
                  Cost
                </TableHeaderCell>
                <TableHeaderCell className="w-[10%]" alignment="right">
                  Cache savings
                </TableHeaderCell>
                <TableHeaderCell className="w-[9%]" alignment="right">
                  Avg TTFC
                </TableHeaderCell>
                <TableHeaderCell className="w-[11%]" alignment="right">
                  Avg tokens/sec
                </TableHeaderCell>
                <TableHeaderCell className="w-[12%]">Calls trend</TableHeaderCell>
                <TableHeaderCell className="w-[12%]">Tokens trend</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.map((u) => {
                const catalogItem = modelLookup.get(u.responseModel);
                const provider = catalogItem?.provider ?? u.genAiSystem;
                const displayId = catalogItem?.displayId ?? `${provider}:${u.responseModel}`;
                const select = catalogItem ? () => onSelectModel(catalogItem) : undefined;
                // Savings = cached reads valued at the normal input rate minus what
                // they actually cost. Needs the model's input price from the catalog.
                const inputPrice = catalogItem?.inputPrice ?? null;
                const cacheSavings =
                  inputPrice != null && u.cachedReadTokens > 0
                    ? Math.max(0, u.cachedReadTokens * inputPrice - u.cachedReadCost)
                    : null;
                return (
                  <TableRow
                    key={u.responseModel}
                    isSelected={!!catalogItem && selectedModelId === catalogItem.friendlyId}
                  >
                    <TableCell onClick={select} isTabbableCell={!!select}>
                      {displayId}
                    </TableCell>
                    <TableCell onClick={select}>
                      <span className="flex items-center gap-1.5">
                        {providerIcon(provider)}
                        {formatProviderName(provider)}
                      </span>
                    </TableCell>
                    <TableCell onClick={select} alignment="right" className="tabular-nums">
                      {formatNumberCompact(u.calls)}
                    </TableCell>
                    <TableCell onClick={select} alignment="right" className="tabular-nums">
                      {formatModelCost(u.totalCost)}
                    </TableCell>
                    <TableCell
                      onClick={select}
                      alignment="right"
                      className="tabular-nums text-emerald-400/80"
                    >
                      {cacheSavings != null ? formatModelCost(cacheSavings) : "—"}
                    </TableCell>
                    <TableCell onClick={select} alignment="right" className="tabular-nums">
                      {u.avgTtfc > 0 ? `${u.avgTtfc.toFixed(0)}ms` : "—"}
                    </TableCell>
                    <TableCell onClick={select} alignment="right" className="tabular-nums">
                      {u.avgTps > 0 ? u.avgTps.toFixed(0) : "—"}
                    </TableCell>
                    <TableCell onClick={select}>
                      <UsageSparkline
                        data={callSparklines[u.responseModel]}
                        bucketStartMs={bucketStartMs}
                        bucketIntervalMs={bucketIntervalMs}
                      />
                    </TableCell>
                    <TableCell onClick={select}>
                      <UsageSparkline
                        data={tokenSparklines[u.responseModel]}
                        bucketStartMs={bucketStartMs}
                        bucketIntervalMs={bucketIntervalMs}
                        color="#10B981"
                        unitLabel={{ singular: "token", plural: "tokens" }}
                        formatTotal={(t) => formatNumberCompact(t)}
                        totalClassName="text-emerald-400"
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

// --- Main Page ---

export default function ModelsPage() {
  const {
    catalog,
    popularModels,
    projectUsage,
    usageSparklines,
    allProviders,
    allFeatures,
    organizationId,
    projectId,
    environmentId,
  } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const aiMetricsBasePath = v3BuiltInDashboardPath(organization, project, environment, "llm");
  const { values: searchValues, value: searchValue, replace } = useSearchParams();

  const search = searchValue("search") ?? "";
  const selectedProviders = searchValues("providers");
  const selectedFeatures = searchValues("features");
  const periodParam = searchValue("period") ?? null;
  const fromParam = searchValue("from") ?? null;
  const toParam = searchValue("to") ?? null;
  // Active tab is persisted in the URL (?tab=) so it survives refresh and is
  // shareable. Defaults to "yours" when there's usage, else "library".
  const tabParam = searchValue("tab");
  const view: ModelsTab =
    tabParam === "library"
      ? "library"
      : tabParam === "yours"
      ? "yours"
      : projectUsage.length > 0
      ? "yours"
      : "library";
  const setView = (next: ModelsTab) => replace({ tab: next });
  const [compareSet, setCompareSet] = useState<Set<string>>(new Set());
  const [showAllDetails, setShowAllDetails] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ModelCatalogItem | null>(null);
  const frozenModel = useFrozenValue(selectedModel);
  const displayModel = selectedModel ?? frozenModel;

  const popularMap = useMemo(() => {
    const map = new Map<string, PopularModel>();
    for (const m of popularModels) {
      map.set(m.responseModel, m);
      if (m.responseModel.includes("/")) {
        map.set(m.responseModel.split("/").slice(1).join("/"), m);
      }
    }
    return map;
  }, [popularModels]);

  const filteredModels = useMemo(() => {
    return catalog
      .flatMap((group) => group.models)
      .filter((m) => {
        if (search && !m.displayId.toLowerCase().includes(search.toLowerCase())) return false;
        if (selectedProviders.length > 0 && !selectedProviders.includes(m.provider)) return false;
        if (selectedFeatures.length > 0 && !selectedFeatures.every((f) => m.features.includes(f)))
          return false;
        return true;
      });
  }, [catalog, search, selectedProviders, selectedFeatures]);

  const toggleCompare = (modelName: string) => {
    setCompareSet((prev) => {
      const next = new Set(prev);
      if (next.has(modelName)) {
        next.delete(modelName);
      } else if (next.size < 4) {
        next.add(modelName);
      }
      return next;
    });
  };

  const compareModels = useMemo(() => Array.from(compareSet), [compareSet]);
  const allModels = useMemo(() => catalog.flatMap((g) => g.models), [catalog]);

  // Resolve a used response_model (base or dated variant) to its catalog card,
  // so a "Your models" row can open the same detail inspector as the library.
  const modelLookup = useMemo(() => {
    const map = new Map<string, ModelCatalogItem>();
    for (const model of allModels) {
      map.set(model.modelName, model);
      for (const variant of model.variants) {
        map.set(variant.modelName, model);
      }
    }
    return map;
  }, [allModels]);

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Models" />
      </NavBar>
      <PageBody scrollable={false}>
        <ResizablePanelGroup orientation="horizontal" className="max-h-full">
          <ResizablePanel id="models-main" min="100px">
            <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden">
              <div className="flex h-fit items-center justify-between gap-2 border-b border-grid-bright pl-3 pr-1.5 pt-1.5">
                <TabContainer className="-mb-px">
                  <TabButton
                    isActive={view === "yours"}
                    layoutId="models-page-tabs"
                    onClick={() => setView("yours")}
                  >
                    Your models
                  </TabButton>
                  <TabButton
                    isActive={view === "library"}
                    layoutId="models-page-tabs"
                    onClick={() => setView("library")}
                  >
                    Model library
                  </TabButton>
                </TabContainer>
                {view === "yours" && (
                  <div className="pb-1.5">
                    <TimeFilter defaultPeriod="7d" labelName="Period" shortcut={{ key: "t" }} />
                  </div>
                )}
              </div>
              {view === "yours" ? (
                <YourModelsTab
                  usage={projectUsage}
                  callSparklines={usageSparklines.calls}
                  tokenSparklines={usageSparklines.tokens}
                  bucketStartMs={usageSparklines.bucketStartMs}
                  bucketIntervalMs={usageSparklines.bucketIntervalMs}
                  organizationId={organizationId}
                  projectId={projectId}
                  environmentId={environmentId}
                  period={periodParam}
                  from={fromParam}
                  to={toParam}
                  modelLookup={modelLookup}
                  selectedModelId={selectedModel?.friendlyId ?? null}
                  onSelectModel={setSelectedModel}
                  onGoToLibrary={() => setView("library")}
                />
              ) : (
                <div className="grid h-full max-h-full grid-rows-[auto_1fr] overflow-hidden">
                  <FiltersBar
                    allProviders={allProviders}
                    allFeatures={allFeatures}
                    compareSet={compareSet}
                    onCompare={() => setCompareOpen(true)}
                    showAllDetails={showAllDetails}
                    onToggleAllDetails={(checked) => setShowAllDetails(checked)}
                  />
                  <ModelsList
                    models={filteredModels}
                    popularMap={popularMap}
                    compareSet={compareSet}
                    onToggleCompare={toggleCompare}
                    showAllDetails={showAllDetails}
                    allFeatures={allFeatures}
                    selectedModelId={selectedModel?.friendlyId ?? null}
                    onSelectModel={setSelectedModel}
                  />
                </div>
              )}
            </div>
          </ResizablePanel>
          <ResizableHandle
            id="models-handle"
            className={collapsibleHandleClassName(!!selectedModel)}
          />
          <ResizablePanel
            id="model-detail"
            default="420px"
            min="420px"
            max="700px"
            className="overflow-hidden"
            collapsible
            collapsed={!selectedModel}
            onCollapseChange={(isCollapsed) => {
              if (isCollapsed) setSelectedModel(null);
            }}
            collapsedSize="0px"
            collapseAnimation={RESIZABLE_PANEL_ANIMATION}
          >
            <div className="h-full" style={{ minWidth: 420 }}>
              {displayModel && (
                <ModelDetailPanel
                  key={displayModel.friendlyId}
                  model={displayModel}
                  organizationId={organizationId}
                  projectId={projectId}
                  environmentId={environmentId}
                  aiMetricsBasePath={aiMetricsBasePath}
                  onClose={() => setSelectedModel(null)}
                />
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </PageBody>
      <CompareDialog
        open={compareOpen}
        onOpenChange={setCompareOpen}
        models={compareModels}
        catalogModels={allModels}
      />
    </PageContainer>
  );
}
