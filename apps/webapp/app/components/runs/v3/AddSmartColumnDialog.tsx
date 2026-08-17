import { BoltIcon } from "@heroicons/react/20/solid";
import { useEffect, useMemo, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Input } from "~/components/primitives/Input";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { Switch } from "~/components/primitives/Switch";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  SMART_COLUMN_DISPLAYS,
  SMART_COLUMN_SOURCES,
  type SmartColumnDef,
  type SmartColumnDisplay,
  type SmartColumnSource,
} from "./runColumns";
import { extractSmartValue, labelFromPath, parseSource } from "./smartColumnData";
import type { loader as sampleLoader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.runs.smart-column-sample";

type AddSmartColumnDialogProps = {
  open: boolean;
  /** When set, the dialog edits this existing column instead of adding a new one. */
  editing: SmartColumnDef | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (def: SmartColumnDef) => void;
  currentSearch: string;
};

const SOURCE_OPTIONS = SMART_COLUMN_SOURCES.map((source) => ({
  label: source.charAt(0).toUpperCase() + source.slice(1),
  value: source,
}));

const DISPLAY_OPTIONS = SMART_COLUMN_DISPLAYS.map((display) => ({
  label: display.charAt(0).toUpperCase() + display.slice(1),
  value: display,
}));

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

  const [source, setSource] = useState<SmartColumnSource>("metadata");
  const [path, setPath] = useState("");
  const [label, setLabel] = useState("");
  const [labelEdited, setLabelEdited] = useState(false);
  const [displayAs, setDisplayAs] = useState<SmartColumnDisplay>("text");

  useEffect(() => {
    if (!open) return;
    setSource(editing?.source ?? "metadata");
    setPath(editing?.path ?? "");
    setLabel(editing?.label ?? "");
    setLabelEdited(editing !== null);
    setDisplayAs(editing?.displayAs ?? "text");
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

  const sampleRun = sample.data?.run ?? null;

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

  const sampleJson = useMemo(() => {
    if (!parsed) return undefined;
    if (parsed.state === "offloaded") return "// offloaded to object storage";
    if (parsed.state === "empty") return "// no value for this run";
    try {
      return JSON.stringify(parsed.value, null, 2);
    } catch {
      return String(parsed.value);
    }
  }, [parsed]);

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
      <DialogContent className="max-w-2xl">
        <DialogHeader>{editing ? "Edit smart column" : "Add smart column"}</DialogHeader>
        <div className="flex flex-col gap-4 p-1">
          <div className="flex flex-col gap-1.5">
            <Label>Source</Label>
            <SegmentedControl
              name="smart-column-source"
              value={source}
              options={SOURCE_OPTIONS}
              onChange={(value: string) => setSource(value as SmartColumnSource)}
              fullWidth
            />
            <Paragraph variant="extra-small" className="text-text-dimmed">
              Metadata is what the run writes about itself while it runs, so it has a value before
              the run ends. Payload is what you triggered it with; output is what it returned.
            </Paragraph>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label>JSON path</Label>
              <Input
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="$.failed"
                spellCheck={false}
              />
              <Paragraph variant="extra-small" className="text-text-dimmed">
                Dot and bracket notation, e.g. <code>$.failed</code> or{" "}
                <code>$.suites[0].name</code>.
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
                Defaults to the last part of the path. Rename it to anything you like.
              </Paragraph>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Display as</Label>
            <SegmentedControl
              name="smart-column-display"
              value={displayAs}
              options={DISPLAY_OPTIONS}
              onChange={(value: string) => setDisplayAs(value as SmartColumnDisplay)}
              fullWidth
            />
            <Paragraph variant="extra-small" className="text-text-dimmed">
              Number right-aligns the column and uses tabular figures. Anything that doesn't parse
              falls back to text.
            </Paragraph>
          </div>

          <div className="grid grid-cols-2 gap-4 rounded border border-grid-dimmed p-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Paragraph variant="extra-extra-small/dimmed/caps">
                Sample — {source} of the newest run
              </Paragraph>
              <pre className="max-h-40 overflow-auto rounded bg-background-dimmed p-2 text-xs text-text-dimmed">
                {sample.state === "loading"
                  ? "Loading…"
                  : sampleRun
                    ? sampleJson
                    : "// no runs to sample"}
              </pre>
            </div>
            <div className="flex flex-col gap-1.5">
              <Paragraph variant="extra-extra-small/dimmed/caps">Resolves to</Paragraph>
              <SmartColumnResolvedPreview label={effectiveLabel} resolved={resolved} />
              {sampleRun && (
                <Paragraph variant="extra-small" className="text-text-dimmed">
                  Against {sampleRun.friendlyId}
                  {sampleRun.hasFinished ? "" : " · still running"}
                </Paragraph>
              )}
            </div>
          </div>

          <div className="flex items-center gap-6 rounded border border-grid-dimmed px-3 py-2 opacity-60">
            <Switch variant="small" label="Sort by this column" disabled checked={false} />
            <Switch variant="small" label="Add to filters" disabled checked={false} />
            <Paragraph variant="extra-small" className="ml-auto text-text-dimmed">
              Both off, and not switchable
            </Paragraph>
          </div>

          <Callout variant="warning">
            Display only. A smart column shows you a value, but you can't sort or filter the list by
            it. To narrow the list, use tags or the query editor.
          </Callout>
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
