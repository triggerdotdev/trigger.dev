import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { useEffect, useMemo, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { SmartColumnIcon } from "~/assets/icons/SmartColumnIcon";
import { Button } from "~/components/primitives/Buttons";
import { Dialog, DialogContent, DialogFooter, DialogHeader } from "~/components/primitives/Dialog";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { cn } from "~/utils/cn";
import {
  SMART_COLUMN_DISPLAYS,
  type SmartColumnDef,
  type SmartColumnDisplay,
  type SmartColumnSource,
} from "./runColumns";
import {
  extractSmartValue,
  labelFromPath,
  parseSource,
  type ParsedSource,
} from "./smartColumnData";
import { SmartColumnSample } from "./SmartColumnSample";
import { isNumericSmartDisplay, SmartCellContent } from "./smartColumnCell";
import type { loader as sampleLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.smart-column-sample";

type AddSmartColumnDialogProps = {
  open: boolean;
  /** When set, the dialog edits this existing column instead of adding a new one. */
  editing: SmartColumnDef | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (def: SmartColumnDef) => void;
  currentSearch: string;
  /**
   * Extra filters merged into the sample request so the preview samples the
   * runs the host page actually lists (e.g. its task or error), for pages that
   * carry that scope in the route path rather than the query string.
   */
  sampleFilters?: Record<string, string>;
};

const SOURCE_CARDS: { value: SmartColumnSource; label: string; description: string }[] = [
  { value: "payload", label: "Payload", description: "What you triggered the run with." },
  { value: "metadata", label: "Metadata", description: "What the run writes while it runs." },
  { value: "output", label: "Output", description: "What the run returned." },
];

const DISPLAY_OPTIONS = SMART_COLUMN_DISPLAYS.map((display) => ({
  label: display.charAt(0).toUpperCase() + display.slice(1),
  value: display,
}));

const DEFAULT_SOURCE: SmartColumnSource = "payload";

export function AddSmartColumnDialog({
  open,
  editing,
  onOpenChange,
  onSubmit,
  currentSearch,
  sampleFilters,
}: AddSmartColumnDialogProps) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();
  const sample = useTypedFetcher<typeof sampleLoader>();

  const [source, setSource] = useState<SmartColumnSource>(DEFAULT_SOURCE);
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [labelEdited, setLabelEdited] = useState(false);
  const [displayAs, setDisplayAs] = useState<SmartColumnDisplay>("text");
  const [sampleIndex, setSampleIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    setSource(editing?.source ?? DEFAULT_SOURCE);
    setPath(editing?.path ?? "");
    setLabel(editing?.label ?? "");
    setLabelEdited(editing !== null);
    setDisplayAs(editing?.displayAs ?? "text");
    setSampleIndex(0);
  }, [open, editing]);

  const sampleFiltersKey = sampleFilters ? JSON.stringify(sampleFilters) : "";
  const sampleUrl = useMemo(() => {
    const base = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/smart-column-sample`;
    const params = new URLSearchParams(currentSearch.replace(/^\?/, ""));
    if (sampleFilters) {
      for (const [key, val] of Object.entries(sampleFilters)) params.set(key, val);
    }
    params.set("source", source);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization.slug, project.slug, environment.slug, currentSearch, sampleFiltersKey, source]);

  useEffect(() => {
    if (open) {
      sample.load(sampleUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sampleUrl]);

  useEffect(() => {
    setSampleIndex(0);
  }, [source]);

  const handleSourceChange = (next: SmartColumnSource) => {
    if (next === source) return;
    setSource(next);
    setPath("");
    setLabel("");
    setLabelEdited(false);
  };

  const effectiveLabel = labelEdited ? label : labelFromPath(path);

  const sampleLoaded = sample.data !== undefined && sample.state === "idle";
  const sampleData = sample.data;

  const { perRun, usable, anyOffloaded, runCount } = useMemo(() => {
    const runs = sampleData?.runs ?? [];
    const perRun = runs.map((run) => ({
      hasFinished: run.hasFinished,
      parsed:
        source === "payload"
          ? parseSource({ data: run.payload, dataType: run.payloadType })
          : source === "metadata"
            ? parseSource({ data: run.metadata, dataType: run.metadataType })
            : parseSource({ data: run.output, dataType: run.outputType }),
    }));
    return {
      runCount: runs.length,
      perRun,
      anyOffloaded: perRun.some((r) => r.parsed.state === "offloaded"),
      usable: perRun.filter(
        (r): r is { hasFinished: boolean; parsed: Extract<ParsedSource, { state: "parsed" }> } =>
          r.parsed.state === "parsed"
      ),
    };
  }, [sampleData, source]);

  const activeIndex = usable.length > 0 ? Math.min(sampleIndex, usable.length - 1) : 0;
  const activeSample = usable[activeIndex]?.parsed;

  const canSubmit = path.trim().length > 0;

  const previewDef: SmartColumnDef = {
    source,
    path: path.trim(),
    label: effectiveLabel,
    displayAs,
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({ source, path: path.trim(), label: effectiveLabel.trim() || path.trim(), displayAs });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Bounded height with the columns absorbing it, so the stacked form can't push the
          header or footer off a short screen. */}
      <DialogContent className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-[860px]!">
        <DialogHeader>{editing ? "Edit smart column" : "Add smart column"}</DialogHeader>
        <div className="flex min-h-0 flex-col gap-5 pt-3">
          <Paragraph variant="base/bright">
            Pick a source, then click a value in the sample to turn it into a column. Smart columns
            are display only — you can't sort or filter by them.
          </Paragraph>

          <div className="grid min-h-0 grid-cols-1 items-stretch gap-2.5 md:grid-cols-3">
            <div className="flex flex-col gap-4 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
              <InputGroup fullWidth>
                <Label>Source</Label>
                <RadioGroup
                  className="flex flex-col gap-2"
                  value={source}
                  onValueChange={(next) => handleSourceChange(next as SmartColumnSource)}
                >
                  {SOURCE_CARDS.map((card) => (
                    <RadioGroupItem
                      key={card.value}
                      id={`smart-source-${card.value}`}
                      value={card.value}
                      variant="description"
                      label={card.label}
                      description={card.description}
                    />
                  ))}
                </RadioGroup>
              </InputGroup>

              <InputGroup fullWidth>
                <Label>JSON path</Label>
                <Input
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="$.order.total"
                  spellCheck={false}
                />
                <Hint className="text-balance">
                  e.g. <code>$.order.total</code>, <code>$.items[0].sku</code>,{" "}
                  <code>$.items.length</code>
                </Hint>
              </InputGroup>

              <InputGroup fullWidth>
                <Label>Column label</Label>
                <Input
                  value={effectiveLabel}
                  onChange={(e) => {
                    setLabel(e.target.value);
                    setLabelEdited(true);
                  }}
                  placeholder={labelFromPath(path)}
                />
              </InputGroup>

              <InputGroup fullWidth>
                <Label>Display as</Label>
                <RadioGroup
                  className="grid grid-cols-2 gap-2"
                  value={displayAs}
                  onValueChange={(next) => setDisplayAs(next as SmartColumnDisplay)}
                >
                  {DISPLAY_OPTIONS.map((option) => (
                    <RadioGroupItem
                      key={option.value}
                      id={`smart-display-${option.value}`}
                      value={option.value}
                      variant="button/small"
                      label={option.label}
                      className="w-full"
                    />
                  ))}
                </RadioGroup>
              </InputGroup>
            </div>

            <div className="flex min-h-0 flex-col gap-1.5">
              <div className="flex min-h-6 items-center justify-between gap-2">
                <Label>Sample {source}</Label>
                {usable.length > 1 && (
                  <SampleRunPicker
                    index={activeIndex}
                    total={usable.length}
                    onPrev={() => setSampleIndex((i) => Math.max(0, i - 1))}
                    onNext={() => setSampleIndex((i) => Math.min(usable.length - 1, i + 1))}
                  />
                )}
              </div>
              <div className="flex-1 overflow-auto rounded-lg border border-grid-dimmed bg-charcoal-900 p-3 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
                {!sampleLoaded ? (
                  <Paragraph variant="extra-small" className="text-text-dimmed">
                    Loading…
                  </Paragraph>
                ) : activeSample ? (
                  <SmartColumnSample
                    value={activeSample.value}
                    activePath={path.trim()}
                    onSelectPath={setPath}
                  />
                ) : runCount === 0 ? (
                  <Paragraph variant="extra-small" className="text-text-dimmed">
                    No runs to sample yet.
                  </Paragraph>
                ) : anyOffloaded ? (
                  <Paragraph variant="extra-small" className="text-text-dimmed">
                    Recent {source}s are too large to sample here.
                  </Paragraph>
                ) : (
                  <Paragraph variant="extra-small" className="text-text-dimmed">
                    No recent run has a {source} to sample.
                  </Paragraph>
                )}
              </div>
            </div>

            <div className="flex min-h-0 flex-col gap-1.5">
              <div className="flex min-h-6 items-center">
                <Label>Preview</Label>
              </div>
              <SmartColumnPreview rows={perRun} def={previewDef} loaded={sampleLoaded} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary/medium" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary/medium" disabled={!canSubmit} onClick={handleSubmit}>
            {editing ? "Save changes" : "Add column"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SampleRunPicker({
  index,
  total,
  onPrev,
  onNext,
}: {
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-none items-center gap-1 text-xs text-text-dimmed">
      <button
        type="button"
        onClick={onPrev}
        disabled={index === 0}
        aria-label="Newer run"
        className="flex size-5 items-center justify-center rounded hover:bg-charcoal-750 disabled:opacity-30"
      >
        <ChevronLeftIcon className="size-4" />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={index >= total - 1}
        aria-label="Older run"
        className="flex size-5 items-center justify-center rounded hover:bg-charcoal-750 disabled:opacity-30"
      >
        <ChevronRightIcon className="size-4" />
      </button>
    </div>
  );
}

function SmartColumnPreview({
  rows,
  def,
  loaded,
}: {
  rows: { hasFinished: boolean; parsed: ParsedSource }[];
  def: SmartColumnDef;
  loaded: boolean;
}) {
  const numeric = isNumericSmartDisplay(def.displayAs);
  const alignClass = numeric ? "justify-end text-right tabular-nums" : "justify-start text-left";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-grid-dimmed">
      <div className="flex flex-none items-center gap-1 border-b border-grid-dimmed bg-background-dimmed px-2.5 py-1.5">
        <SmartColumnIcon className="size-3.5 flex-none text-text-dimmed" />
        <span className="truncate text-xs font-medium text-text-bright">
          {def.label || "Column"}
        </span>
      </div>
      <div className="flex-1 overflow-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
        {!loaded ? (
          <div className="px-2.5 py-2 text-xs text-text-dimmed">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="px-2.5 py-2 text-xs text-text-dimmed">No runs yet</div>
        ) : (
          rows.map((row, index) => {
            const cell = def.path
              ? extractSmartValue(row.parsed, def.path)
              : ({ state: "empty" } as const);
            return (
              <div
                key={index}
                className={cn(
                  "flex h-8 items-center border-b border-grid-dimmed/60 px-2.5 text-sm last:border-b-0",
                  alignClass
                )}
              >
                <SmartCellContent cell={cell} def={def} provisional={!row.hasFinished} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
