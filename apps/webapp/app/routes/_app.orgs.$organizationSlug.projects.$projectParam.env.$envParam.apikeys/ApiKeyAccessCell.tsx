import {
  type ApiKeyCapabilityCatalogue,
  type ApiKeyCapabilityDifference,
  type ApiKeyCapabilityMap,
} from "@trigger.dev/plugins";
import { Badge } from "~/components/primitives/Badge";
import {
  SimpleTooltip,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { type ApiKeyAccessPreset, driftLine, summarizeCapabilities } from "~/utils/apiKeyAccess";
import { CapabilityList } from "./ApiKeyCapabilities";

export function ApiKeyAccessCell({
  label,
  taskIdentifiers,
  usesTaskSelection = false,
  isCustom = false,
  fullAccess = false,
  capabilities,
  unmatchedScopes,
  catalogue,
  presets,
  drift = [],
  onReviewDrift,
}: {
  label: string;
  taskIdentifiers?: string[];
  usesTaskSelection?: boolean;
  isCustom?: boolean;
  fullAccess?: boolean;
  capabilities?: ApiKeyCapabilityMap;
  unmatchedScopes?: string[];
  catalogue?: ApiKeyCapabilityCatalogue | null;
  presets?: ApiKeyAccessPreset[] | null;
  drift?: ApiKeyCapabilityDifference[];
  onReviewDrift?: () => void;
}) {
  const summary =
    catalogue && capabilities
      ? summarizeCapabilities(catalogue, capabilities, presets, taskIdentifiers)
      : undefined;
  const cell = (
    <div className="flex flex-col gap-0.5 text-left">
      <span className="flex items-center gap-1.5 text-xs text-text-bright">
        {isCustom ? (
          <>
            <Badge variant="extra-small">Custom</Badge>
            {summary && !summary.listsRows ? summary.text : null}
          </>
        ) : (
          label
        )}
      </span>
      {usesTaskSelection ? (
        <span className="text-xs text-text-dimmed">
          {taskIdentifiers === undefined
            ? "All tasks"
            : `${taskIdentifiers.length} selected ${taskIdentifiers.length === 1 ? "task" : "tasks"}`}
        </span>
      ) : null}
    </div>
  );

  if (!catalogue || (!capabilities && !fullAccess)) {
    return <div className="min-w-40">{cell}</div>;
  }

  const hasDrift = drift.length > 0;
  return (
    <div className="flex min-w-40 items-start gap-0.5">
      <SimpleTooltip
        button={cell}
        side="left"
        className="w-72 p-3"
        content={
          <div className="space-y-2">
            <div className="text-xs font-medium text-text-bright">
              {fullAccess
                ? "Full access to this environment"
                : isCustom
                  ? (summary?.text ?? label)
                  : label}
            </div>
            <CapabilityList
              catalogue={catalogue}
              capabilities={capabilities ?? {}}
              fullAccess={fullAccess}
              grantedOnly={!fullAccess}
              unmatchedScopes={unmatchedScopes}
              taskIdentifiers={taskIdentifiers}
            />
            {hasDrift ? (
              <div className="space-y-1.5 border-t border-grid-dimmed pt-2">
                <div className="text-xs font-medium text-text-bright">
                  Differs from {label} today
                </div>
                <ul className="space-y-0.5">
                  {drift.map((difference) => (
                    <li key={difference.capabilityId} className="text-xs text-text-dimmed">
                      {driftLine(catalogue, difference)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        }
      />
      {hasDrift ? <DriftMarker presetLabel={label} onActivate={onReviewDrift} /> : null}
    </div>
  );
}

function DriftMarker({
  presetLabel,
  onActivate,
}: {
  presetLabel: string;
  onActivate?: () => void;
}) {
  const text = `Access differs from the current ${presetLabel} preset`;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          type="button"
          aria-label={text}
          onClick={onActivate}
          className="mt-px rounded-full p-1 outline-none focus-visible:ring-1 focus-visible:ring-text-dimmed"
        >
          <span className="block size-1.5 rounded-full bg-text-dimmed" />
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
