import { DialogClose } from "@radix-ui/react-dialog";
import {
  type ApiKeyCapabilityCatalogue,
  type ApiKeyCapabilityDifference,
  apiKeyCapabilityDifferences,
  CUSTOM_API_KEY_PRESET_ID,
  FULL_ACCESS_PRESET_ID,
} from "@trigger.dev/plugins";
import { useEffect, useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { EnvironmentCombo } from "~/components/environments/EnvironmentLabel";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { DateTime } from "~/components/primitives/DateTime";
import { Dialog, DialogContent, DialogHeader } from "~/components/primitives/Dialog";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  type ApiKeyAccessPreset,
  capabilityName,
  grantsTaskAccess,
  initialApiKeyAccess,
  levelLabel,
  scopesLostOnSave,
  type StoredApiKeyAccess,
  taskSelectionChange,
} from "~/utils/apiKeyAccess";
import { cn } from "~/utils/cn";
import { ApiKeyAccessFields, ApiKeyAccessInputs, ApiKeyAccessPane } from "./ApiKeyAccessPicker";
import type { action, ApiKeyActionData } from "./route";
import { defaultApiKeyPresetId, useApiKeyAccess } from "./useApiKeyAccess";

export type EditableApiKey = {
  id: string;
  name: string;
  expiresAt: Date | string | null;
  allowedIpRanges: string[];
  unmatchedScopes?: string[];
} & StoredApiKeyAccess;

export function EditApiKeyAccessDialog({
  apiKey,
  uneditableMessage,
  driftPresetLabel,
  open,
  onOpenChange,
  availableTasks,
  presets,
  capabilityCatalogue,
  isRbacPluginAvailable,
  canManagePresets,
  environment,
}: {
  apiKey: EditableApiKey;
  uneditableMessage?: string;
  driftPresetLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  availableTasks: string[];
  presets: ApiKeyAccessPreset[] | null;
  capabilityCatalogue: ApiKeyCapabilityCatalogue | null;
  isRbacPluginAvailable: boolean;
  canManagePresets: boolean;
  environment: React.ComponentProps<typeof EnvironmentCombo>["environment"];
}) {
  const fetcher = useTypedFetcher<typeof action>();
  const actionData = fetcher.data as ApiKeyActionData | undefined;
  const [showError, setShowError] = useState(false);
  const [initial] = useState(() =>
    initialApiKeyAccess(
      apiKey,
      presets,
      defaultApiKeyPresetId(presets),
      driftPresetLabel !== undefined
    )
  );
  const access = useApiKeyAccess({
    presets,
    catalogue: capabilityCatalogue,
    isRbacPluginAvailable,
    canManagePresets,
    initial,
  });
  const [confirming, setConfirming] = useState(driftPresetLabel !== undefined);
  const [driftNote, setDriftNote] = useState(driftPresetLabel);

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
    selectedTasks,
    needsSelectedTask,
    nextTasks,
    nextFullAccess,
    nextCapabilities,
    nextPresetId,
    deletedPresetNote,
    canSubmitAccess,
  } = access;
  const differences =
    capabilityCatalogue && !apiKey.fullAccess && !nextFullAccess
      ? apiKeyCapabilityDifferences(
          capabilityCatalogue.capabilities,
          apiKey.capabilities ?? {},
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "max-h-[80vh] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 pt-2.5",
          showAccessControls ? "lg:max-w-[62rem]" : "lg:max-w-[40rem]"
        )}
      >
        <DialogHeader className="flex flex-row items-center gap-2.5 px-5 pb-3">
          Edit access
          <EnvironmentCombo environment={environment} className="text-xs" iconClassName="size-4" />
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
            <div className="min-h-0 space-y-4 overflow-y-auto px-5 pb-6 pt-4">
              <Paragraph variant="small/bright">Save the new access for {apiKey.name}?</Paragraph>
              {driftNote ? (
                <Paragraph variant="small">
                  {apiKey.name} keeps the access it was created with. Updating gives it what{" "}
                  {driftNote} grants today.
                </Paragraph>
              ) : null}
              <AccessChanges
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
                showAccessControls && "lg:grid-cols-[minmax(0,1fr)_21rem]"
              )}
            >
              <div className={cn("min-w-0 px-5 pb-6 pt-4", showAccessControls && "space-y-5")}>
                <ApiKeyDetails apiKey={apiKey} bordered={showAccessControls} />
                <ApiKeyAccessFields access={access} availableTasks={availableTasks} />
              </div>

              <ApiKeyAccessPane access={access} />
            </div>
          )}

          <div className="flex items-center gap-3 border-t border-grid-bright px-5 py-3">
            {(() => {
              const error =
                (showError && actionData && !actionData.ok ? actionData.error : null) ??
                uneditableMessage ??
                deletedPresetNote ??
                null;
              const hint =
                needsSelectedTask && selectedTasks.length === 0
                  ? "Pick at least one task, or switch to all tasks."
                  : changesNothing
                    ? "No changes to save."
                    : "";
              return (
                <span
                  className={cn(
                    "min-w-0 truncate text-xs",
                    error ? "text-error" : "text-text-dimmed"
                  )}
                >
                  {error ?? hint}
                </span>
              );
            })()}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              {uneditableMessage ? (
                <DialogClose asChild>
                  <Button variant="secondary/small">Close</Button>
                </DialogClose>
              ) : confirming ? (
                <Button
                  type="button"
                  variant="tertiary/small"
                  onClick={() => {
                    setConfirming(false);
                    setDriftNote(undefined);
                  }}
                >
                  Back
                </Button>
              ) : (
                <DialogClose asChild>
                  <Button variant="tertiary/small">Cancel</Button>
                </DialogClose>
              )}
              {uneditableMessage ? null : !confirming ? (
                <Button
                  key="review"
                  type="button"
                  variant="primary/small"
                  disabled={changesNothing || !canSubmitAccess}
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
                  variant="primary/small"
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

function ApiKeyDetails({ apiKey, bordered }: { apiKey: EditableApiKey; bordered: boolean }) {
  return (
    <div
      className={cn(
        "grid items-start gap-4 pb-5 sm:grid-cols-[minmax(0,1fr)_16rem]",
        bordered && "border-b border-grid-dimmed"
      )}
    >
      <InputGroup fullWidth>
        <Label htmlFor="api-key-name">Name</Label>
        <Input id="api-key-name" value={apiKey.name} readOnly disabled fullWidth />
      </InputGroup>
      <InputGroup fullWidth>
        <Label>Expires</Label>
        <Paragraph variant="small" className="py-1.5">
          {apiKey.expiresAt ? <DateTime date={apiKey.expiresAt} /> : "Never"}
        </Paragraph>
      </InputGroup>
      <InputGroup fullWidth className="sm:col-span-2">
        <Label>Allowed IPs</Label>
        <Paragraph variant="small">
          {apiKey.allowedIpRanges.length > 0 ? apiKey.allowedIpRanges.join(", ") : "Any IP"}
        </Paragraph>
        <Hint>Name, expiry and allowed IPs stay as they are. Only access changes here.</Hint>
      </InputGroup>
    </div>
  );
}

function AccessChanges({
  catalogue,
  differences,
  taskChange,
  fullAccessChange,
  lostScopes,
}: {
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
    <div className="space-y-3">
      {fullAccessChange ? (
        <p className="text-xs text-text-bright">
          {fullAccessChange === "gains"
            ? "This key will gain full access to this environment."
            : "This key will lose full access to this environment."}
        </p>
      ) : null}
      {groups.map((group) => (
        <div key={group.title} className="space-y-1">
          <div className="text-xs font-medium text-text-bright">{group.title}</div>
          <ul className="space-y-0.5">
            {group.rows.map((row) => (
              <li key={row.capabilityId} className="text-xs text-text-dimmed">
                <span className="text-text-bright">
                  {capabilityName(catalogue, row.capabilityId)}
                </span>
                {": "}
                {levelLabel(catalogue, row.capabilityId, row.to)} (was{" "}
                {levelLabel(catalogue, row.capabilityId, row.from)})
              </li>
            ))}
          </ul>
        </div>
      ))}
      {taskChange ? <p className="text-xs text-text-dimmed">{taskChange}</p> : null}
      {lostScopes.length > 0 ? (
        <div className="space-y-1">
          <div className="text-xs font-medium text-text-bright">
            This key will lose scopes that no access level covers
          </div>
          <ul className="space-y-0.5">
            {lostScopes.map((scope) => (
              <li key={scope} className="font-mono text-xs text-text-dimmed">
                {scope}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {!fullAccessChange && groups.length === 0 && !taskChange && lostScopes.length === 0 ? (
        <p className="text-xs text-text-dimmed">The key keeps the same access.</p>
      ) : null}
    </div>
  );
}
