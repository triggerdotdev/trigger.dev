import { type ApiKeyCapabilityCatalogue, type ApiKeyCapabilityMap } from "@trigger.dev/plugins";
import { Badge } from "~/components/primitives/Badge";
import { SimpleTooltip } from "~/components/primitives/Tooltip";
import { type ApiKeyAccessPreset, summarizeCapabilities } from "~/utils/apiKeyAccess";

export function ApiKeyAccessLabel({
  label,
  isCustom = false,
  capabilities,
  catalogue,
  presets,
  taskIdentifiers,
}: {
  label: string;
  isCustom?: boolean;
  capabilities?: ApiKeyCapabilityMap;
  catalogue?: ApiKeyCapabilityCatalogue | null;
  presets?: ApiKeyAccessPreset[] | null;
  taskIdentifiers?: string[];
}) {
  if (!isCustom) return <span>{label}</span>;
  const summary =
    catalogue && capabilities
      ? summarizeCapabilities(catalogue, capabilities, presets, taskIdentifiers)
      : undefined;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge variant="extra-small">Custom</Badge>
      {summary && !summary.listsRows ? summary.text : null}
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
  hasDrift = false,
}: {
  label: string;
  taskIdentifiers?: string[];
  usesTaskSelection?: boolean;
  isCustom?: boolean;
  capabilities?: ApiKeyCapabilityMap;
  catalogue?: ApiKeyCapabilityCatalogue | null;
  presets?: ApiKeyAccessPreset[] | null;
  hasDrift?: boolean;
}) {
  return (
    <div className="flex min-w-40 items-start gap-0.5">
      <div className="flex flex-col gap-0.5 text-left">
        <span className="flex items-center gap-1.5 text-xs text-text-bright">
          <ApiKeyAccessLabel
            label={label}
            isCustom={isCustom}
            capabilities={capabilities}
            catalogue={catalogue}
            presets={presets}
            taskIdentifiers={taskIdentifiers}
          />
        </span>
        {usesTaskSelection ? (
          <span className="text-xs text-text-dimmed">
            {taskIdentifiers === undefined
              ? "All tasks"
              : `${taskIdentifiers.length} selected ${taskIdentifiers.length === 1 ? "task" : "tasks"}`}
          </span>
        ) : null}
      </div>
      {hasDrift ? <DriftMarker presetLabel={label} /> : null}
    </div>
  );
}

function DriftMarker({ presetLabel }: { presetLabel: string }) {
  return (
    <SimpleTooltip
      asChild
      side="top"
      className="text-xs"
      content={`The ${presetLabel} preset now grants more than this key has`}
      button={
        <span className="mt-px block p-1">
          <span className="block size-1.5 rounded-full bg-text-dimmed" />
        </span>
      }
    />
  );
}
