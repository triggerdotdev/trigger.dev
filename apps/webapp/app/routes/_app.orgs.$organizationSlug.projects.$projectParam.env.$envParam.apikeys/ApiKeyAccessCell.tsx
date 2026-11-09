import { type ApiKeyCapabilityCatalogue, type ApiKeyCapabilityMap } from "@trigger.dev/plugins";
import { Badge } from "~/components/primitives/Badge";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { TruncatedText } from "~/components/primitives/TruncatedText";
import { type ApiKeyAccessPreset, summarizeCapabilities } from "~/utils/apiKeyAccess";

/** The inspector's access line: the preset name, or a Custom badge with a summary under it. */
export function ApiKeyAccessLabel({
  label,
  isCustom = false,
  isOrganizationPreset = false,
  presetDeleted = false,
  capabilities,
  unmatchedScopes,
  catalogue,
  presets,
  taskIdentifiers,
}: {
  label: string;
  isCustom?: boolean;
  isOrganizationPreset?: boolean;
  presetDeleted?: boolean;
  capabilities?: ApiKeyCapabilityMap;
  unmatchedScopes?: string[];
  catalogue?: ApiKeyCapabilityCatalogue | null;
  presets?: ApiKeyAccessPreset[] | null;
  taskIdentifiers?: string[];
}) {
  if (!isCustom) {
    return (
      <span className="inline-flex items-baseline gap-1.5">
        {label}
        {isOrganizationPreset ? <span className="text-xs text-text-dimmed">Org preset</span> : null}
      </span>
    );
  }
  const summary =
    catalogue && capabilities
      ? summarizeCapabilities(catalogue, capabilities, presets, taskIdentifiers, unmatchedScopes)
      : undefined;
  return (
    <span className="flex flex-col gap-1">
      <span className="inline-flex items-center gap-1.5">
        <Badge variant="extra-small">Custom</Badge>
        {presetDeleted ? <span className="text-xs">(its preset was deleted)</span> : null}
        {summary && !summary.listsRows ? summary.text : null}
      </span>
      {summary?.basedOn ? <span className="text-xs">{summary.basedOn}</span> : null}
    </span>
  );
}

export function ApiKeyAccessCell({
  label,
  taskIdentifiers,
  usesTaskSelection = false,
  isCustom = false,
  capabilities,
  catalogue,
  presets,
  unmatchedScopes,
  hasDrift = false,
}: {
  label: string;
  taskIdentifiers?: string[];
  usesTaskSelection?: boolean;
  isCustom?: boolean;
  capabilities?: ApiKeyCapabilityMap;
  unmatchedScopes?: string[];
  catalogue?: ApiKeyCapabilityCatalogue | null;
  presets?: ApiKeyAccessPreset[] | null;
  hasDrift?: boolean;
}) {
  // Task names are left out here: the count at the end stands for them, with the names in its
  // tooltip, so a long list can't push it out of view.
  const summary =
    isCustom && catalogue && capabilities
      ? summarizeCapabilities(catalogue, capabilities, presets, undefined, unmatchedScopes)
      : undefined;
  const text = isCustom ? (summary && !summary.listsRows ? summary.text : undefined) : label;

  // One line: the label truncates first, so the task scope and drift marker stay readable. No
  // colours of its own: the cell dims it and brightens it on row hover, like the other data.
  return (
    <div className="flex max-w-[22rem] items-center gap-1.5 text-xs">
      {isCustom ? (
        <Badge variant="extra-small" className="shrink-0">
          Custom
        </Badge>
      ) : null}
      {text ? <TruncatedText text={text} className="min-w-0" /> : null}
      {usesTaskSelection ? <TaskScope taskIdentifiers={taskIdentifiers} /> : null}
      {hasDrift ? <DriftMarker presetLabel={label} /> : null}
    </div>
  );
}

function TaskScope({ taskIdentifiers }: { taskIdentifiers?: string[] }) {
  const count = taskIdentifiers?.length ?? 0;
  const scope = (
    <span className="shrink-0 whitespace-nowrap">
      · {taskIdentifiers === undefined ? "All tasks" : `${count} ${count === 1 ? "task" : "tasks"}`}
    </span>
  );
  if (!taskIdentifiers || count === 0) return scope;
  return (
    <SimpleTooltip
      asChild
      side="top"
      disableHoverableContent
      button={scope}
      content={
        <ul className="flex flex-col gap-0.5 font-mono text-xs">
          {taskIdentifiers.map((task) => (
            <li key={task}>{task}</li>
          ))}
        </ul>
      }
    />
  );
}

function DriftMarker({ presetLabel }: { presetLabel: string }) {
  return (
    <SimpleTooltip
      asChild
      side="top"
      className="text-xs"
      disableHoverableContent
      content={`The ${presetLabel} preset now grants more than this key has`}
      button={
        <span className="block shrink-0 p-1">
          <span className="block size-1.5 rounded-full bg-text-dimmed group-hover/table-row:bg-text-bright" />
        </span>
      }
    />
  );
}
