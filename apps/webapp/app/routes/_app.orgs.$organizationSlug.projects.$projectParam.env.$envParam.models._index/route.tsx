import {
  AdjustmentsHorizontalIcon,
  ListBulletIcon,
  MagnifyingGlassIcon,
  Squares2X2Icon,
} from "@heroicons/react/20/solid";
import { Link, type MetaFunction, useNavigate } from "@remix-run/react";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { useMemo, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { AppliedFilter } from "~/components/primitives/AppliedFilter";
import { Badge } from "~/components/primitives/Badge";
import { Button } from "~/components/primitives/Buttons";
import { Checkbox } from "~/components/primitives/Checkbox";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { NavBar, PageAccessories, PageTitle } from "~/components/primitives/PageHeader";
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
import {
  EnvironmentParamSchema,
  v3ModelComparePath,
  v3ModelDetailPath,
} from "~/utils/pathBuilder";
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
        <SelectTrigger variant="minimal/small" tooltipTitle="Filter by provider">
          {selected.length === 0 ? (
            <span className="flex items-center gap-1 text-xs text-text-dimmed">
              <AdjustmentsHorizontalIcon className="h-3.5 w-3.5" />
              Provider
            </span>
          ) : null}
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
        <SelectTrigger variant="minimal/small" tooltipTitle="Filter by capability">
          {selected.length === 0 ? (
            <span className="flex items-center gap-1 text-xs text-text-dimmed">
              <AdjustmentsHorizontalIcon className="h-3.5 w-3.5" />
              Capability
            </span>
          ) : null}
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
        <SelectTrigger variant="minimal/small" tooltipTitle="Filter by feature support">
          {selected.length === 0 ? (
            <span className="flex items-center gap-1 text-xs text-text-dimmed">
              <AdjustmentsHorizontalIcon className="h-3.5 w-3.5" />
              Features
            </span>
          ) : null}
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

// --- Model Card ---

function ModelCard({
  model,
  popular,
  onToggleCompare,
  isSelected,
}: {
  model: ModelCatalogItem;
  popular?: PopularModel;
  onToggleCompare: (modelName: string) => void;
  isSelected: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const detailPath = v3ModelDetailPath(organization, project, environment, model.friendlyId);

  return (
    <div className="group relative flex flex-col gap-2.5 rounded-md border border-grid-dimmed bg-background-bright p-4 transition-colors hover:border-grid-bright">
      <div className="absolute right-3 top-3" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={isSelected}
          onChange={() => onToggleCompare(model.modelName)}
          title="Select for comparison"
        />
      </div>

      <Link to={detailPath} className="text-sm font-medium text-text-bright hover:underline">
        {model.displayId}
      </Link>

      {model.description && (
        <p className="line-clamp-2 text-xs text-text-dimmed">{model.description}</p>
      )}

      <div className="flex items-center gap-4 text-xs tabular-nums text-text-dimmed">
        <span title="Input price per 1M tokens">
          {formatModelPrice(model.inputPrice)}/1M in
        </span>
        <span title="Output price per 1M tokens">
          {formatModelPrice(model.outputPrice)}/1M out
        </span>
        {model.contextWindow && (
          <span title="Context window">{formatTokenCount(model.contextWindow)} ctx</span>
        )}
      </div>

      {model.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {model.capabilities.map((cap) => (
            <Badge key={cap} variant="outline-rounded">
              {formatCapability(cap)}
            </Badge>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3 text-xs tabular-nums text-text-dimmed">
        {popular && popular.callCount > 0 && (
          <span>{formatNumberCompact(popular.callCount)} calls (7d)</span>
        )}
        {popular && popular.ttfcP50 > 0 && (
          <span title="p50 time to first chunk">{popular.ttfcP50.toFixed(0)}ms TTFC</span>
        )}
      </div>

      {model.variants.length > 0 && <VariantsDropdown variants={model.variants} />}
    </div>
  );
}

function VariantsDropdown({ variants }: { variants: ModelCatalogItem["variants"] }) {
  const [isOpen, setIsOpen] = useState(false);
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  return (
    <div>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-xs text-text-dimmed hover:text-text-bright"
      >
        <span
          className={`inline-block text-[10px] transition-transform ${isOpen ? "rotate-90" : ""}`}
        >
          &#9654;
        </span>
        {variants.length} version{variants.length !== 1 ? "s" : ""}
      </button>
      {isOpen && (
        <div className="mt-1.5 space-y-0.5 border-l border-charcoal-700 pl-3">
          {variants.map((v) => (
            <Link
              key={v.friendlyId}
              to={v3ModelDetailPath(organization, project, environment, v.friendlyId)}
              className="block text-xs text-text-dimmed hover:text-text-bright"
            >
              {v.modelName}
              {v.releaseDate && (
                <span className="ml-1.5 text-charcoal-500">{v.releaseDate}</span>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Models Table ---

function ModelsTable({
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

  return (
    <Table containerClassName="border-t-0">
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
                {popular && popular.callCount > 0
                  ? formatNumberCompact(popular.callCount)
                  : "—"}
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
  const searchParams = useSearchParams();

  const view = searchParams.value("view") ?? "cards";
  const search = searchParams.value("search") ?? "";
  const selectedProviders = searchParams.values("providers");
  const selectedCapabilities = searchParams.values("capabilities");
  const selectedFeatures = searchParams.values("features") as FeatureKey[];
  const [compareSet, setCompareSet] = useState<Set<string>>(new Set());

  const popularMap = useMemo(() => {
    const map = new Map<string, PopularModel>();
    for (const m of popularModels) {
      // Index by raw response_model
      map.set(m.responseModel, m);
      // Also index by model name without provider prefix (e.g. "openai/gpt-4o" → "gpt-4o")
      if (m.responseModel.includes("/")) {
        map.set(m.responseModel.split("/").slice(1).join("/"), m);
      }
    }
    return map;
  }, [popularModels]);

  const filteredCatalog = useMemo(() => {
    return catalog
      .map((group) => ({
        ...group,
        models: group.models.filter((m) => {
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
        }),
      }))
      .filter((group) => group.models.length > 0);
  }, [catalog, search, selectedProviders, selectedCapabilities, selectedFeatures]);

  const allFilteredModels = useMemo(
    () => filteredCatalog.flatMap((g) => g.models),
    [filteredCatalog]
  );

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

  const hasActiveFilters =
    selectedProviders.length > 0 ||
    selectedCapabilities.length > 0 ||
    selectedFeatures.length > 0;

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Models" />
        <PageAccessories>
          <div className="flex items-center gap-2">
            <div className="relative">
              <MagnifyingGlassIcon className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-text-dimmed" />
              <Input
                placeholder="Search models..."
                value={search}
                onChange={(e) => searchParams.replace({ search: e.target.value || undefined })}
                variant="small"
                className="pl-8"
                fullWidth={false}
              />
            </div>

            <div className="flex items-center overflow-hidden rounded-sm border border-charcoal-700">
              <button
                onClick={() => searchParams.replace({ view: "cards" })}
                className={`p-1.5 transition-colors ${view === "cards" ? "bg-charcoal-700 text-text-bright" : "text-text-dimmed hover:text-text-bright"}`}
              >
                <Squares2X2Icon className="h-4 w-4" />
              </button>
              <button
                onClick={() => searchParams.replace({ view: "table" })}
                className={`p-1.5 transition-colors ${view === "table" ? "bg-charcoal-700 text-text-bright" : "text-text-dimmed hover:text-text-bright"}`}
              >
                <ListBulletIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </PageAccessories>
      </NavBar>
      <PageBody scrollable>
        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-grid-dimmed px-4 py-2">
          <ProviderFilter providers={allProviders} />
          <CapabilityFilter capabilities={allCapabilities} />
          <FeaturesFilter />
          {hasActiveFilters && (
            <Button
              variant="minimal/small"
              onClick={() => searchParams.del(["providers", "capabilities", "features"])}
            >
              Clear all
            </Button>
          )}
        </div>

        {/* Compare bar */}
        {compareSet.size >= 2 && (
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-grid-dimmed bg-background-dimmed px-4 py-2">
            <span className="text-sm text-text-dimmed">{compareSet.size} models selected</span>
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

        {view === "cards" ? (
          <div className="space-y-6 p-4">
            {filteredCatalog.map((group) => (
              <div key={group.provider}>
                <Header2 className="mb-3">{formatProviderName(group.provider)}</Header2>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {group.models.map((model) => (
                    <ModelCard
                      key={model.friendlyId}
                      model={model}
                      popular={popularMap.get(model.modelName)}
                      onToggleCompare={toggleCompare}
                      isSelected={compareSet.has(model.modelName)}
                    />
                  ))}
                </div>
              </div>
            ))}
            {filteredCatalog.length === 0 && (
              <p className="py-8 text-center text-sm text-text-dimmed">
                No models match your filters.
              </p>
            )}
          </div>
        ) : (
          <ModelsTable
            models={allFilteredModels}
            popularMap={popularMap}
            compareSet={compareSet}
            onToggleCompare={toggleCompare}
          />
        )}
      </PageBody>
    </PageContainer>
  );
}
