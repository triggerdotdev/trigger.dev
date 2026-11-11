import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { DialogClose } from "@radix-ui/react-dialog";
import {
  type ApiKeyCapabilityCatalogue,
  type ApiKeyCapabilityDifference,
  type ApiKeyCapabilityMap,
  apiKeyCapabilityDifferences,
  CUSTOM_API_KEY_PRESET_ID,
  FULL_ACCESS_PRESET_ID,
} from "@trigger.dev/plugins";
import { useEffect, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { Header3 } from "~/components/primitives/Headers";
import { Hint } from "~/components/primitives/Hint";
import { Callout } from "~/components/primitives/Callout";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  type ApiKeyAccessPreset,
  capabilityName,
  grantsTaskAccess,
  initialApiKeyAccess,
  levelLabel,
  OTHER_SCOPES_NOTE,
  scopesLostOnSave,
  type StoredApiKeyAccess,
  taskSelectionChange,
} from "~/utils/apiKeyAccess";
import { type ApiKeyUsageView, fullAccessCapabilities, lossNote } from "~/utils/apiKeyUsage";
import { cn } from "~/utils/cn";
import { ApiKeyAccessFields, ApiKeyAccessInputs, ApiKeyAccessPane } from "./ApiKeyAccessPicker";
import type { action, ApiKeyActionData } from "./route";
import { MAX_API_KEY_TASK_IDENTIFIERS } from "~/consts";
import { defaultApiKeyPresetId, useApiKeyAccess } from "./useApiKeyAccess";

export type EditableApiKey = {
  id: string;
  name: string;
  unmatchedScopes?: string[];
  usage?: ApiKeyUsageView | null;
} & StoredApiKeyAccess;

export type EditAccessStart =
  | { kind: "drift"; presetLabel: string }
  | { kind: "narrow"; capabilities: ApiKeyCapabilityMap; windowDays: number };

export function EditApiKeyAccessDialog({
  apiKey,
  uneditableMessage,
  start,
  open,
  onOpenChange,
  availableTasks,
  presets,
  capabilityCatalogue,
  isRbacPluginAvailable,
  canManagePresets,
  environment,
  now,
}: {
  apiKey: EditableApiKey;
  uneditableMessage?: string;
  start?: EditAccessStart;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableTasks: string[];
  presets: ApiKeyAccessPreset[] | null;
  capabilityCatalogue: ApiKeyCapabilityCatalogue | null;
  isRbacPluginAvailable: boolean;
  canManagePresets: boolean;
  environment: React.ComponentProps<typeof EnvironmentCombo>["environment"];
  now: number;
}) {
  const fetcher = useTypedFetcher<typeof action>();
  const actionData = fetcher.data as ApiKeyActionData | undefined;
  const [showError, setShowError] = useState(false);
  const [initial] = useState(() => {
    const stored = initialApiKeyAccess(
      apiKey,
      presets,
      defaultApiKeyPresetId(presets),
      start?.kind === "drift"
    );
    return start?.kind === "narrow"
      ? { ...stored, mode: "custom" as const, capabilities: start.capabilities }
      : stored;
  });
  const access = useApiKeyAccess({
    presets,
    catalogue: capabilityCatalogue,
    isRbacPluginAvailable,
    canManagePresets,
    initial,
  });
  const [confirming, setConfirming] = useState(start !== undefined);
  const [startNote] = useState(start);

  useEffect(() => {
    if (fetcher.state !== "idle") {
      return;
    }

    if (actionData && !actionData.ok) {
      // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setShowError(true);
      setConfirming(false);
    }
  }, [actionData, fetcher.state]);

  useEffect(() => {
    if (fetcher.state === "idle" && actionData?.ok && actionData.action === "update-access") {
      onOpenChange(false);
    }
  }, [actionData, fetcher.state, onOpenChange]);

  const {
    showAccessControls,
    nextTasks,
    nextFullAccess,
    nextCapabilities,
    nextPresetId,
    deletedPresetNote,
    canSubmitAccess,
  } = access;
  const differences =
    capabilityCatalogue && !nextFullAccess
      ? apiKeyCapabilityDifferences(
          capabilityCatalogue.capabilities,
          apiKey.fullAccess
            ? fullAccessCapabilities(capabilityCatalogue)
            : (apiKey.capabilities ?? {}),
          nextCapabilities
        )
      : [];
  const taskChange = taskSelectionChange(
    {
      grantsTasks: capabilityCatalogue
        ? grantsTaskAccess(capabilityCatalogue, apiKey.capabilities ?? {}, apiKey.fullAccess)
        : true,
      tasks: apiKey.taskIdentifiers ?? [],
    },
    {
      grantsTasks: capabilityCatalogue
        ? grantsTaskAccess(capabilityCatalogue, nextCapabilities, nextFullAccess)
        : true,
      tasks: nextTasks,
    }
  );
  const fullAccessChange =
    apiKey.fullAccess !== nextFullAccess
      ? nextFullAccess
        ? ("gains" as const)
        : ("loses" as const)
      : undefined;
  const lostScopes =
    nextFullAccess || !capabilityCatalogue
      ? []
      : scopesLostOnSave(
          capabilityCatalogue,
          apiKey.unmatchedScopes ?? [],
          nextCapabilities,
          nextTasks
        );
  const changesNothing =
    differences.length === 0 &&
    lostScopes.length === 0 &&
    !taskChange &&
    !fullAccessChange &&
    (initial.mode === "custom"
      ? CUSTOM_API_KEY_PRESET_ID
      : (apiKey.presetId ?? FULL_ACCESS_PRESET_ID)) === nextPresetId;

  const error =
    (showError && actionData && !actionData.ok ? actionData.error : null) ??
    uneditableMessage ??
    deletedPresetNote ??
    null;
  const saveBlocker = !canSubmitAccess
    ? saveBlockedReason(access)
    : changesNothing
      ? "No changes to save."
      : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-h-[80vh] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 pt-2.5",
          // The confirm step is a short summary, so it doesn't need the editor's width.
          confirming ? "lg:max-w-xl" : showAccessControls ? "lg:max-w-[62rem]" : "lg:max-w-[40rem]"
        )}
      >
        <DialogHeader className="flex flex-row items-center gap-1.5 px-5 pb-3">
          Edit access for {apiKey.name}
          <EnvironmentCombo
            environment={environment}
            className="text-base"
            iconClassName="size-5"
          />
        </DialogHeader>
        <fetcher.Form
          method="post"
          onSubmit={() => setShowError(false)}
          className="grid min-h-0 grid-rows-[minmax(0,1fr)_auto]"
        >
          <input type="hidden" name="action" value="update-access" />
          <input type="hidden" name="apiKeyId" value={apiKey.id} />
          <ApiKeyAccessInputs access={access} />
          {confirming && capabilityCatalogue ? (
            <div className="min-h-0 space-y-5 overflow-y-auto px-5 pb-5 pt-4 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control">
              <div className="space-y-1">
                <Paragraph variant="base/bright">Save the new access for {apiKey.name}?</Paragraph>
                {startNote?.kind === "drift" ? (
                  <Paragraph variant="small">
                    {apiKey.name} keeps the access it was created with. Updating gives it what{" "}
                    {startNote.presetLabel} grants today.
                  </Paragraph>
                ) : startNote?.kind === "narrow" ? (
                  <Paragraph variant="small">
                    Each area is set to the smallest level that covers what {apiKey.name} used in
                    the last {startNote.windowDays} days.
                  </Paragraph>
                ) : null}
              </div>
              <AccessChanges
                usage={apiKey.usage ?? undefined}
                now={now}
                catalogue={capabilityCatalogue}
                differences={differences}
                taskChange={taskChange}
                fullAccessChange={fullAccessChange}
                lostScopes={lostScopes}
              />
              <Callout variant="info">
                The secret stays the same, so nothing needs redeploying. The new access applies to
                the key's next request.
              </Callout>
            </div>
          ) : (
            <div
              className={cn(
                "grid min-h-0 grid-cols-1 overflow-y-auto scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control",
                // The scrollbar runs beside the summary pane, so its track takes the pane's colour.
                showAccessControls &&
                  "lg:grid-cols-[minmax(0,1fr)_21rem] lg:scrollbar-track-background-deep"
              )}
            >
              <div className={cn("min-w-0 px-5 pb-6 pt-4", showAccessControls && "space-y-5")}>
                {apiKey.unmatchedScopes && apiKey.unmatchedScopes.length > 0 ? (
                  <Callout variant="warning" className={showAccessControls ? undefined : "mb-5"}>
                    This key also has{" "}
                    <span className="font-mono">{apiKey.unmatchedScopes.join(", ")}</span>.{" "}
                    {OTHER_SCOPES_NOTE}
                  </Callout>
                ) : null}
                <ApiKeyAccessFields access={access} availableTasks={availableTasks} />
              </div>

              <ApiKeyAccessPane access={access} />
            </div>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-grid-bright p-3">
            {uneditableMessage ? (
              <DialogClose asChild>
                <Button variant="secondary/medium">Close</Button>
              </DialogClose>
            ) : confirming && !startNote ? (
              // Reached from the editor: Back returns to the edits instead of discarding them.
              <Button type="button" variant="secondary/medium" onClick={() => setConfirming(false)}>
                Back
              </Button>
            ) : (
              // Opened on this step (drift or narrowing), so there's nothing to go back to.
              <DialogClose asChild>
                <Button variant="secondary/medium">{confirming ? "Close" : "Cancel"}</Button>
              </DialogClose>
            )}
            <div className="flex min-w-0 items-center gap-3">
              <span className="min-w-0 truncate text-xs text-error">{error}</span>
              {uneditableMessage ? null : !confirming ? (
                <Button
                  key="review"
                  type="button"
                  variant="primary/medium"
                  className="shrink-0"
                  disabled={saveBlocker !== undefined}
                  tooltip={saveBlocker}
                  onClick={() => {
                    setShowError(false);
                    setConfirming(true);
                  }}
                >
                  Save access…
                </Button>
              ) : (
                <Button
                  key="save"
                  type="submit"
                  variant="primary/medium"
                  className="shrink-0"
                  disabled={!canSubmitAccess || fetcher.state !== "idle"}
                  isLoading={fetcher.state !== "idle"}
                >
                  Save access
                </Button>
              )}
            </div>
          </div>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

function saveBlockedReason(access: ReturnType<typeof useApiKeyAccess>): string {
  if (access.needsSelectedTask && access.selectedTasks.length === 0) {
    return "Pick at least one task, or switch to all tasks.";
  }
  if (access.needsSelectedTask && access.selectedTasks.length > MAX_API_KEY_TASK_IDENTIFIERS) {
    return `Select at most ${MAX_API_KEY_TASK_IDENTIFIERS} tasks.`;
  }
  if (access.isCustom && !access.hasCustomCapabilities) {
    return "Give the key access to at least one area.";
  }
  if (!access.selectedPresetIsAvailable) {
    return "Your plan doesn't include this access.";
  }
  return "This access can't be saved.";
}

function LossNote({
  catalogue,
  row,
  usage,
  now,
}: {
  catalogue: ApiKeyCapabilityCatalogue;
  row: ApiKeyCapabilityDifference;
  usage: ApiKeyUsageView;
  now: number;
}) {
  const capability = catalogue.capabilities.find((candidate) => candidate.id === row.capabilityId);
  if (!capability) return null;
  const note = lossNote(capability, row.to, usage, now);
  return <Hint>{note.charAt(0).toUpperCase() + note.slice(1)}</Hint>;
}

function AccessChanges({
  usage,
  now,
  catalogue,
  differences,
  taskChange,
  fullAccessChange,
  lostScopes,
}: {
  usage?: ApiKeyUsageView;
  now: number;
  catalogue: ApiKeyCapabilityCatalogue;
  differences: ApiKeyCapabilityDifference[];
  taskChange?: string;
  fullAccessChange?: "gains" | "loses";
  lostScopes: string[];
}) {
  const groups = [
    { title: "This key will gain", rows: differences.filter((d) => d.gains && !d.loses) },
    { title: "This key will lose", rows: differences.filter((d) => d.loses && !d.gains) },
    { title: "This key will change", rows: differences.filter((d) => d.gains && d.loses) },
  ].filter((group) => group.rows.length > 0);

  return (
    <div className="space-y-5">
      {fullAccessChange ? (
        <Paragraph variant="small/bright">
          {fullAccessChange === "gains"
            ? "This key will gain full access to this environment."
            : "This key will lose full access to this environment."}
        </Paragraph>
      ) : null}
      {groups.map((group) => (
        <div key={group.title}>
          <Header3 className="mb-2">{group.title}</Header3>
          <ul className="divide-y divide-grid-dimmed rounded-md border border-grid-bright">
            {group.rows.map((row) => (
              <li key={row.capabilityId} className="px-3 py-2">
                <div className="flex items-center justify-between gap-4">
                  <Paragraph variant="small/bright">
                    {capabilityName(catalogue, row.capabilityId)}
                  </Paragraph>
                  <span className="flex shrink-0 items-center gap-1.5 text-sm">
                    <span className="text-text-dimmed">
                      {levelLabel(catalogue, row.capabilityId, row.from)}
                    </span>
                    <ArrowRightIcon className="size-3.5 text-text-dimmed" aria-label="to" />
                    <span className="text-text-bright">
                      {levelLabel(catalogue, row.capabilityId, row.to)}
                    </span>
                  </span>
                </div>
                {usage && row.loses ? (
                  <LossNote catalogue={catalogue} row={row} usage={usage} now={now} />
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {taskChange ? <Paragraph variant="small">{taskChange}</Paragraph> : null}
      {lostScopes.length > 0 ? (
        <div>
          <Header3 className="mb-2">This key will lose scopes that no access level covers</Header3>
          <ul className="divide-y divide-grid-dimmed rounded-md border border-grid-bright">
            {lostScopes.map((scope) => (
              <li key={scope} className="px-3 py-2 font-mono text-xs text-text-dimmed">
                {scope}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!fullAccessChange && groups.length === 0 && !taskChange && lostScopes.length === 0 ? (
        <Paragraph variant="small">The key keeps the same access.</Paragraph>
      ) : null}
    </div>
  );
}
