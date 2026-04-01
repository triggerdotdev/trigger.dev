import { AdjustmentsHorizontalIcon, CheckIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form, type MetaFunction, useFetcher } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/primitives/Dialog";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { SearchInput } from "~/components/primitives/SearchInput";
import { Switch } from "~/components/primitives/Switch";
import {
  SelectProvider,
  SelectTrigger,
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
import { appliedSummary } from "~/components/runs/v3/SharedFilters";
import { useSearchParams } from "~/hooks/useSearchParam";
import { useOptimisticLocation } from "~/hooks/useOptimisticLocation";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  type ModelCatalogItem,
  type ModelComparisonItem,
  type PopularModel,
  ModelRegistryPresenter,
} from "~/presenters/v3/ModelRegistryPresenter.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { requireUserId } from "~/services/session.server";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { EnvironmentParamSchema, v3ModelComparePath, v3ModelDetailPath } from "~/utils/pathBuilder";
import {
  formatModelPrice,
  formatTokenCount,
  formatCapability,
  formatProviderName,
  formatModelCost,
} from "~/utils/modelFormatters";
import { formatNumberCompact } from "~/utils/numberFormatter";
import { Spinner } from "~/components/primitives/Spinner";

import { type loader as compareLoader } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.models.compare/route";

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

  const presenter = new ModelRegistryPresenter(clickhouseClient);
  const catalog = await presenter.getModelCatalog();

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const popularModels = await presenter.getPopularModels(sevenDaysAgo, now, 50);

  const allProviders = catalog.map((g) => g.provider);
  const allCapabilities = Array.from(
    new Set(catalog.flatMap((g) => g.models.flatMap((m) => m.capabilities)))
  ).sort();

  return typedjson({ catalog, popularModels, allProviders, allCapabilities });
};

// --- Helpers ---

const FEATURE_OPTIONS = [
  { value: "structuredOutput", label: "Structured output" },
  { value: "parallelToolCalls", label: "Parallel tool calls" },
  { value: "streamingToolCalls", label: "Streaming tool calls" },
] as const;

type FeatureKey = (typeof FEATURE_OPTIONS)[number]["value"];

function modelMatchesFeature(model: ModelCatalogItem, feature: FeatureKey): boolean {
  switch (feature) {
    case "structuredOutput":
      return model.supportsStructuredOutput;
    case "parallelToolCalls":
      return model.supportsParallelToolCalls;
    case "streamingToolCalls":
      return model.supportsStreamingToolCalls;
  }
}

// --- Filter Components ---

function ProviderFilter({ providers }: { providers: string[] }) {
  const { values, replace, del } = useSearchParams();
  const selected = values("providers");

  return (
    <>
      <SelectProvider value={selected} setValue={(v) => replace({ providers: v })}>
        <SelectTrigger
          icon={<AdjustmentsHorizontalIcon className="size-4" />}
          variant="secondary/small"
          tooltipTitle="Filter by provider"
        >
          <span className="ml-0.5">Provider</span>
        </SelectTrigger>
        <SelectPopover>
          <SelectList>
            {providers.map((p) => (
              <SelectItem key={p} value={p}>
                {formatProviderName(p)}
              </SelectItem>
            ))}
          </SelectList>
        </SelectPopover>
      </SelectProvider>
      {selected.length > 0 && (
        <AppliedFilter
          label="Provider"
          value={appliedSummary(selected.map(formatProviderName))!}
          onRemove={() => del("providers")}
        />
      )}
    </>
  );
}

function CapabilityFilter({ capabilities }: { capabilities: string[] }) {
  const { values, replace, del } = useSearchParams();
  const selected = values("capabilities");

  return (
    <>
      <SelectProvider value={selected} setValue={(v) => replace({ capabilities: v })}>
        <SelectTrigger
          icon={<AdjustmentsHorizontalIcon className="size-4" />}
          variant="secondary/small"
          tooltipTitle="Filter by capability"
        >
          <span className="ml-0.5">Capability</span>
        </SelectTrigger>
        <SelectPopover>
          <SelectList>
            {capabilities.map((c) => (
              <SelectItem key={c} value={c}>
                {formatCapability(c)}
              </SelectItem>
            ))}
          </SelectList>
        </SelectPopover>
      </SelectProvider>
      {selected.length > 0 && (
        <AppliedFilter
          label="Capability"
          value={appliedSummary(selected.map(formatCapability))!}
          onRemove={() => del("capabilities")}
        />
      )}
    </>
  );
}

function FeaturesFilter() {
  const { values, replace, del } = useSearchParams();
  const selected = values("features");

  return (
    <>
      <SelectProvider value={selected} setValue={(v) => replace({ features: v })}>
        <SelectTrigger
          icon={<AdjustmentsHorizontalIcon className="size-4" />}
          variant="secondary/small"
          tooltipTitle="Filter by feature support"
        >
          <span className="ml-0.5">Features</span>
        </SelectTrigger>
        <SelectPopover>
          <SelectList>
            {FEATURE_OPTIONS.map((f) => (
              <SelectItem key={f.value} value={f.value}>
                {f.label}
              </SelectItem>
            ))}
          </SelectList>
        </SelectPopover>
      </SelectProvider>
      {selected.length > 0 && (
        <AppliedFilter
          label="Features"
          value={
            appliedSummary(
              selected.map((s) => FEATURE_OPTIONS.find((f) => f.value === s)?.label ?? s)
            )!
          }
          onRemove={() => del("features")}
        />
      )}
    </>
  );
}

// --- Filters Bar ---

function FiltersBar({
  allProviders,
  allCapabilities,
  compareSet,
  onCompare,
  showAllDetails,
  onToggleAllDetails,
}: {
  allProviders: string[];
  allCapabilities: string[];
  compareSet: Set<string>;
  onCompare: () => void;
  showAllDetails: boolean;
  onToggleAllDetails: (checked: boolean) => void;
}) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("providers") ||
    searchParams.has("capabilities") ||
    searchParams.has("features") ||
    searchParams.has("search");

  const compareDisabled = compareSet.size < 2;

  return (
    <div className="flex items-start justify-between gap-x-2 border-b border-grid-bright p-2">
      <div className="flex flex-row flex-wrap items-center gap-2">
        <ProviderFilter providers={allProviders} />
        <CapabilityFilter capabilities={allCapabilities} />
        <FeaturesFilter />
        <SearchInput placeholder="Search models…" />
        {hasFilters && (
          <Form className="h-6">
            <Button variant="secondary/small" LeadingIcon={XMarkIcon} tooltip="Clear all filters" />
          </Form>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button
          variant="secondary/small"
          disabled={compareDisabled}
          className="px-1.5"
          tooltip={compareDisabled ? "Choose 2–4 models to compare" : "Compare selected models"}
          onClick={compareDisabled ? undefined : onCompare}
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
        <Switch
          variant="secondary/small"
          label="All details"
          checked={showAllDetails}
          onCheckedChange={onToggleAllDetails}
        />
      </div>
    </div>
  );
}

// --- Models Table ---

function BooleanCell({ value, path }: { value: boolean; path: string }) {
  return (
    <TableCell to={path} alignment="center">
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
}: {
  models: ModelCatalogItem[];
  popularMap: Map<string, PopularModel>;
  compareSet: Set<string>;
  onToggleCompare: (modelName: string) => void;
  showAllDetails: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  if (models.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-center text-sm text-text-dimmed">No models match your filters.</p>
      </div>
    );
  }

  return (
    <Table containerClassName="max-h-full pb-[2.5rem]" showTopBorder={false}>
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
              <TableHeaderCell>Capabilities</TableHeaderCell>
              <TableHeaderCell>Release date</TableHeaderCell>
              <TableHeaderCell alignment="center">Structured output</TableHeaderCell>
              <TableHeaderCell alignment="center">Parallel tools</TableHeaderCell>
              <TableHeaderCell alignment="center">Streaming tools</TableHeaderCell>
            </>
          )}
          <TableHeaderCell alignment="right">p50 TTFC</TableHeaderCell>
          <TableHeaderCell alignment="right">Calls (7d)</TableHeaderCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {models.map((model) => {
          const path = v3ModelDetailPath(organization, project, environment, model.friendlyId);
          const popular = popularMap.get(model.modelName);
          return (
            <TableRow key={model.friendlyId}>
              <TableCell>
                <Checkbox
                  checked={compareSet.has(model.modelName)}
                  onChange={() => onToggleCompare(model.modelName)}
                  disabled={compareSet.size >= 4 && !compareSet.has(model.modelName)}
                />
              </TableCell>
              <TableCell to={path} isTabbableCell>
                {model.displayId}
              </TableCell>
              <TableCell to={path}>{formatProviderName(model.provider)}</TableCell>
              <TableCell to={path} alignment="right" className="tabular-nums">
                {formatModelPrice(model.inputPrice)}
              </TableCell>
              <TableCell to={path} alignment="right" className="tabular-nums">
                {formatModelPrice(model.outputPrice)}
              </TableCell>
              <TableCell to={path} alignment="right" className="tabular-nums">
                {formatTokenCount(model.contextWindow)}
              </TableCell>
              {showAllDetails && (
                <>
                  <TableCell to={path} alignment="right" className="tabular-nums">
                    {formatTokenCount(model.maxOutputTokens)}
                  </TableCell>
                  <TableCell to={path}>
                    {model.capabilities.length > 0
                      ? model.capabilities.map(formatCapability).join(", ")
                      : "—"}
                  </TableCell>
                  <TableCell to={path}>
                    {model.releaseDate ? (
                      <DateTime date={model.releaseDate} includeTime={false} />
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <BooleanCell value={model.supportsStructuredOutput} path={path} />
                  <BooleanCell value={model.supportsParallelToolCalls} path={path} />
                  <BooleanCell value={model.supportsStreamingToolCalls} path={path} />
                </>
              )}
              <TableCell to={path} alignment="right" className="tabular-nums">
                {popular && popular.ttfcP50 > 0 ? `${popular.ttfcP50.toFixed(0)}ms` : "—"}
              </TableCell>
              <TableCell to={path} alignment="right" className="tabular-nums">
                {popular && popular.callCount > 0 ? formatNumberCompact(popular.callCount) : "—"}
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
        return c ? formatProviderName(c.provider) : dataMap.get(m)?.genAiSystem ?? "—";
      }),
    },
    {
      label: "Input $/1M",
      values: inputPrices.map((v) => formatModelPrice(v)),
      bestIndex: findBest(inputPrices, true),
    },
    {
      label: "Output $/1M",
      values: outputPrices.map((v) => formatModelPrice(v)),
      bestIndex: findBest(outputPrices, true),
    },
    {
      label: "Context window",
      values: contextWindows.map((v) => formatTokenCount(v)),
      bestIndex: findBest(contextWindows, false),
    },
    {
      label: "Max output",
      values: maxOutputs.map((v) => formatTokenCount(v)),
      bestIndex: findBest(maxOutputs, false),
    },
    {
      label: "Capabilities",
      values: models.map((m) => {
        const c = getCatalog(m);
        return c && c.capabilities.length > 0
          ? c.capabilities.map(formatCapability).join(", ")
          : "—";
      }),
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
    {
      label: "Structured output",
      values: models.map((m) =>
        getCatalog(m)?.supportsStructuredOutput ? (
          <CheckIcon className="size-4 text-success/70 group-hover/table-row:text-success" />
        ) : (
          "—"
        )
      ),
    },
    {
      label: "Parallel tools",
      values: models.map((m) =>
        getCatalog(m)?.supportsParallelToolCalls ? (
          <CheckIcon className="size-4 text-success/70 group-hover/table-row:text-success" />
        ) : (
          "—"
        )
      ),
    },
    {
      label: "Streaming tools",
      values: models.map((m) =>
        getCatalog(m)?.supportsStreamingToolCalls ? (
          <CheckIcon className="size-4 text-success/70 group-hover/table-row:text-success" />
        ) : (
          "—"
        )
      ),
    },
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

  const isLoading = fetcher.state === "loading";
  const comparison = (fetcher.data as any)?.comparison as ModelComparisonItem[] | undefined;
  const rows = useMemo(
    () => buildComparisonRows(models, catalogModels, comparison ?? []),
    [comparison, models, catalogModels]
  );

  useEffect(() => {
    if (open && models.length >= 2) {
      const params = models.join(",");
      fetcher.load(`${v3ModelComparePath(organization, project, environment)}?models=${params}`);
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!w-fit !px-0 !pb-0 sm:!max-w-[90vw]">
        <DialogHeader className="px-4">
          <DialogTitle>Compare models</DialogTitle>
        </DialogHeader>
        {rows.length > 0 ? (
          <div className="-mt-[0.375rem] max-h-[70vh] overflow-auto [&_tbody_tr:last-child]:after:hidden">
            <Table showTopBorder={false}>
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

// --- Main Page ---

export default function ModelsPage() {
  const { catalog, popularModels, allProviders, allCapabilities } =
    useTypedLoaderData<typeof loader>();
  const { values: searchValues, value: searchValue } = useSearchParams();

  const search = searchValue("search") ?? "";
  const selectedProviders = searchValues("providers");
  const selectedCapabilities = searchValues("capabilities");
  const selectedFeatures = searchValues("features") as FeatureKey[];
  const [compareSet, setCompareSet] = useState<Set<string>>(new Set());
  const [showAllDetails, setShowAllDetails] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);

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
        if (
          selectedCapabilities.length > 0 &&
          !selectedCapabilities.every((c) => m.capabilities.includes(c))
        )
          return false;
        if (
          selectedFeatures.length > 0 &&
          !selectedFeatures.every((f) => modelMatchesFeature(m, f))
        )
          return false;
        return true;
      });
  }, [catalog, search, selectedProviders, selectedCapabilities, selectedFeatures]);

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

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Models" />
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid h-full max-h-full grid-rows-[2.5rem_1fr] overflow-hidden">
          <FiltersBar
            allProviders={allProviders}
            allCapabilities={allCapabilities}
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
          />
        </div>
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
