import { AdjustmentsHorizontalIcon, XMarkIcon } from "@heroicons/react/20/solid";
import { Form, type MetaFunction, useNavigate } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Button } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { SearchInput } from "~/components/primitives/SearchInput";
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
} from "~/utils/modelFormatters";
import { formatNumberCompact } from "~/utils/numberFormatter";

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
  { value: "structuredOutput", label: "Structured Output" },
  { value: "parallelToolCalls", label: "Parallel Tool Calls" },
  { value: "streamingToolCalls", label: "Streaming Tool Calls" },
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
        <SelectTrigger variant="secondary/small" tooltipTitle="Filter by provider">
          <AdjustmentsHorizontalIcon className="size-4" />
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
        <SelectTrigger variant="secondary/small" tooltipTitle="Filter by capability">
          <AdjustmentsHorizontalIcon className="size-4" />
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
        <SelectTrigger variant="secondary/small" tooltipTitle="Filter by feature support">
          <AdjustmentsHorizontalIcon className="size-4" />
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
}: {
  allProviders: string[];
  allCapabilities: string[];
}) {
  const location = useOptimisticLocation();
  const searchParams = new URLSearchParams(location.search);
  const hasFilters =
    searchParams.has("providers") ||
    searchParams.has("capabilities") ||
    searchParams.has("features") ||
    searchParams.has("search");

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
    </div>
  );
}

// --- Models Table ---

function ModelsList({
  models,
  popularMap,
  compareSet,
  onToggleCompare,
}: {
  models: ModelCatalogItem[];
  popularMap: Map<string, PopularModel>;
  compareSet: Set<string>;
  onToggleCompare: (modelName: string) => void;
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
                />
              </TableCell>
              <TableCell to={path} isTabbableCell>
                <span className="font-medium text-text-bright">{model.displayId}</span>
              </TableCell>
              <TableCell to={path}>{formatProviderName(model.provider)}</TableCell>
              <TableCell to={path} alignment="right">
                {formatModelPrice(model.inputPrice)}
              </TableCell>
              <TableCell to={path} alignment="right">
                {formatModelPrice(model.outputPrice)}
              </TableCell>
              <TableCell to={path} alignment="right">
                {formatTokenCount(model.contextWindow)}
              </TableCell>
              <TableCell to={path} alignment="right">
                {popular && popular.ttfcP50 > 0 ? `${popular.ttfcP50.toFixed(0)}ms` : "—"}
              </TableCell>
              <TableCell to={path} alignment="right">
                {popular && popular.callCount > 0 ? formatNumberCompact(popular.callCount) : "—"}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

// --- Main Page ---

export default function ModelsPage() {
  const { catalog, popularModels, allProviders, allCapabilities } =
    useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const navigate = useNavigate();
  const { values: searchValues, value: searchValue } = useSearchParams();

  const search = searchValue("search") ?? "";
  const selectedProviders = searchValues("providers");
  const selectedCapabilities = searchValues("capabilities");
  const selectedFeatures = searchValues("features") as FeatureKey[];
  const [compareSet, setCompareSet] = useState<Set<string>>(new Set());

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

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Models" />
      </NavBar>
      <PageBody scrollable={false}>
        <div className="grid max-h-full grid-rows-[auto_1fr] overflow-hidden">
          <FiltersBar allProviders={allProviders} allCapabilities={allCapabilities} />
          {compareSet.size >= 2 && (
            <div className="flex shrink-0 items-center justify-between border-b border-grid-bright bg-background-dimmed px-3 py-2">
              <span className="text-sm text-text-dimmed">
                {compareSet.size} models selected
              </span>
              <div className="flex items-center gap-2">
                <Button variant="tertiary/small" onClick={() => setCompareSet(new Set())}>
                  Clear
                </Button>
                <Button
                  variant="primary/small"
                  onClick={() => {
                    const params = Array.from(compareSet).join(",");
                    navigate(
                      `${v3ModelComparePath(organization, project, environment)}?models=${params}`
                    );
                  }}
                >
                  Compare ({compareSet.size})
                </Button>
              </div>
            </div>
          )}
          <ModelsList
            models={filteredModels}
            popularMap={popularMap}
            compareSet={compareSet}
            onToggleCompare={toggleCompare}
          />
        </div>
      </PageBody>
    </PageContainer>
  );
}
