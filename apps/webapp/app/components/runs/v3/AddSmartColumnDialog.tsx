import { BoltIcon, ChevronLeftIcon, ChevronRightIcon } from "@heroicons/react/20/solid";
import { useEffect, useMemo, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
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
import { extractSmartValue, labelFromPath, parseSource } from "./smartColumnData";
import { SmartColumnSample } from "./SmartColumnSample";
import type { loader as sampleLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.smart-column-sample";

type AddSmartColumnDialogProps = {
  open: boolean;
  /** When set, the dialog edits this existing column instead of adding a new one. */
  editing: SmartColumnDef | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (def: SmartColumnDef) => void;
  currentSearch: string;
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

  const sampleUrl = useMemo(() => {
    const base = `/resources/orgs/${organization.slug}/projects/${project.slug}/env/${environment.slug}/runs/smart-column-sample`;
    return currentSearch ? `${base}?${currentSearch.replace(/^\?/, "")}` : base;
  }, [organization.slug, project.slug, environment.slug, currentSearch]);

  useEffect(() => {
    if (open && sample.state === "idle" && sample.data === undefined) {
      sample.load(sampleUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sampleUrl]);

  const effectiveLabel = labelEdited ? label : labelFromPath(path);

  const sampleRuns = sample.data?.runs ?? [];
  const clampedIndex = sampleRuns.length > 0 ? Math.min(sampleIndex, sampleRuns.length - 1) : 0;
  const sampleRun = sampleRuns[clampedIndex] ?? null;

  const parsed = useMemo(() => {
    if (!sampleRun) return undefined;
    switch (source) {
      case "payload":
        return parseSource({ data: sampleRun.payload, dataType: sampleRun.payloadType });
      case "metadata":
        return parseSource({ data: sampleRun.metadata, dataType: sampleRun.metadataType });
      case "output":
        return parseSource({ data: sampleRun.output, dataType: sampleRun.outputType });
    }
  }, [sampleRun, source]);

  const resolved = useMemo(() => {
    if (!parsed || path.trim().length === 0) return undefined;
    return extractSmartValue(parsed, path);
  }, [parsed, path]);

  const canSubmit = path.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    onSubmit({ source, path: path.trim(), label: effectiveLabel.trim() || path.trim(), displayAs });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[820px]!">
        <DialogHeader>{editing ? "Edit smart column" : "Add smart column"}</DialogHeader>
        <div className="flex flex-col gap-5 p-1">
          <Callout variant="info">
            Display only. A smart column shows you a value from a run, but you can't sort or filter
            the list by it. To narrow the list, use tags or the query editor.
          </Callout>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-[1fr_300px]">
            <div className="flex flex-col gap-5">
              <div className="flex flex-col gap-1.5">
                <Label>Source</Label>
                <div className="grid grid-cols-3 gap-2">
                  {SOURCE_CARDS.map((card) => (
                    <SourceCard
                      key={card.value}
                      label={card.label}
                      description={card.description}
                      selected={source === card.value}
                      onSelect={() => setSource(card.value)}
                    />
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="flex flex-col gap-1.5">
                  <Label>JSON path</Label>
                  <Input
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="$.order.total"
                    spellCheck={false}
                  />
                  <Paragraph variant="extra-small" className="text-text-dimmed">
                    Dot and bracket notation, e.g. <code>$.order.total</code> or{" "}
                    <code>$.items[0].sku</code>.
                  </Paragraph>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label>Column label</Label>
                  <Input
                    value={effectiveLabel}
                    onChange={(e) => {
                      setLabel(e.target.value);
                      setLabelEdited(true);
                    }}
                    placeholder={labelFromPath(path)}
                  />
                  <Paragraph variant="extra-small" className="text-text-dimmed">
                    Defaults to the last part of the path.
                  </Paragraph>
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label>Display as</Label>
                <div className="flex flex-wrap gap-2">
                  {DISPLAY_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setDisplayAs(option.value)}
                      className={cn(
                        "rounded-full border px-3.5 py-1 text-sm transition",
                        displayAs === option.value
                          ? "border-blue-500 bg-blue-500/10 text-text-bright"
                          : "border-grid-bright text-text-dimmed hover:text-text-bright"
                      )}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <Paragraph variant="extra-small" className="text-text-dimmed">
                  Number right-aligns the column and uses tabular figures. Anything that doesn't
                  parse falls back to text.
                </Paragraph>
              </div>
            </div>

            <div className="flex flex-col gap-1.5 self-start rounded-lg border border-grid-dimmed bg-background-dimmed p-3">
              <div className="flex items-center justify-between gap-2">
                <Paragraph variant="extra-extra-small/dimmed/caps">Sample — {source}</Paragraph>
                {sampleRuns.length > 0 && (
                  <SampleRunPicker
                    index={clampedIndex}
                    total={sampleRuns.length}
                    onPrev={() => setSampleIndex((i) => Math.max(0, i - 1))}
                    onNext={() => setSampleIndex((i) => Math.min(sampleRuns.length - 1, i + 1))}
                  />
                )}
              </div>
              {sample.state === "loading" ? (
                <Paragraph variant="extra-small" className="text-text-dimmed">
                  Loading…
                </Paragraph>
              ) : !parsed ? (
                <Paragraph variant="extra-small" className="text-text-dimmed">
                  No runs to sample.
                </Paragraph>
              ) : parsed.state === "offloaded" ? (
                <Paragraph variant="extra-small" className="text-text-dimmed">
                  This {source} is offloaded to object storage, too large to sample here.
                </Paragraph>
              ) : parsed.state === "empty" ? (
                <Paragraph variant="extra-small" className="text-text-dimmed">
                  No {source} value for this run.
                </Paragraph>
              ) : (
                <>
                  <SmartColumnSample
                    value={parsed.value}
                    activePath={path.trim()}
                    onSelectPath={setPath}
                  />
                  <Paragraph variant="extra-small" className="text-text-dimmed">
                    Click a value to use its path. Expand objects and arrays to reach the value you
                    want.
                  </Paragraph>
                </>
              )}
              <Paragraph variant="extra-extra-small/dimmed/caps" className="mt-2">
                Resolves to
              </Paragraph>
              <SmartColumnResolvedPreview label={effectiveLabel} resolved={resolved} />
            </div>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-grid-dimmed p-3">
          <Button variant="tertiary/medium" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary/medium" disabled={!canSubmit} onClick={handleSubmit}>
            {editing ? "Save changes" : "Add column"}
          </Button>
        </div>
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
      <span className="tabular-nums">
        {index + 1}/{total}
      </span>
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

function SourceCard({
  label,
  description,
  selected,
  onSelect,
}: {
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex flex-col gap-1 rounded-lg border p-2.5 text-left transition",
        selected
          ? "border-blue-500 bg-blue-500/10"
          : "border-grid-bright bg-background-dimmed hover:border-text-dimmed"
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium text-text-bright">
        <span
          className={cn(
            "grid size-3.5 flex-none place-items-center rounded-full border",
            selected ? "border-blue-500" : "border-text-dimmed"
          )}
        >
          {selected && <span className="size-1.5 rounded-full bg-blue-500" />}
        </span>
        {label}
      </span>
      <span className="text-xs text-text-dimmed">{description}</span>
    </button>
  );
}

function SmartColumnResolvedPreview({
  label,
  resolved,
}: {
  label: string;
  resolved: ReturnType<typeof extractSmartValue> | undefined;
}) {
  let value: string;
  if (!resolved) value = "–";
  else if (resolved.state === "offloaded") value = "Too large";
  else if (resolved.state === "empty") value = "–";
  else if (typeof resolved.value === "object") value = JSON.stringify(resolved.value);
  else value = String(resolved.value);

  return (
    <div className="rounded border border-grid-dimmed">
      <div className="flex items-center gap-1 border-b border-grid-dimmed px-2 py-1">
        <BoltIcon className="size-3.5 flex-none text-text-dimmed" />
        <span className="truncate text-xs text-text-bright">{label || "Column"}</span>
      </div>
      <div className="px-2 py-1.5 text-right text-sm tabular-nums text-text-bright">{value}</div>
    </div>
  );
}
