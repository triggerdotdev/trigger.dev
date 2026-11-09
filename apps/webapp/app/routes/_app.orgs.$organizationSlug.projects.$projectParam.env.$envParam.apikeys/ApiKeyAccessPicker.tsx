import { TrashIcon } from "@heroicons/react/20/solid";
import {
  type ApiKeyCapabilityCatalogue,
  type ApiKeyCapabilityMap,
  CUSTOM_API_KEY_PRESET_ID,
  RESTRICTED_API_KEYS_PLAN_MESSAGE,
} from "@trigger.dev/plugins";
import { useState } from "react";
import { useTypedFetcher } from "remix-typedjson";
import { Feedback } from "~/components/Feedback";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Hint } from "~/components/primitives/Hint";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/Popover";
import { RadioGroup, RadioGroupItem } from "~/components/primitives/RadioButton";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { TextLink } from "~/components/primitives/TextLink";
import { useFeatures } from "~/hooks/useFeatures";
import { useOrganization } from "~/hooks/useOrganizations";
import { useShowSelfServe } from "~/hooks/useShowSelfServe";
import {
  type ApiKeyAccessPreset,
  summarizeCapabilities,
  type TaskScope,
} from "~/utils/apiKeyAccess";
import { cn } from "~/utils/cn";
import { v3BillingPath } from "~/utils/pathBuilder";
import { CapabilityList, CustomCapabilityEditor, TaskScopeControl } from "./ApiKeyCapabilities";
import type { action, ApiKeyActionData } from "./route";
import type { ApiKeyAccessState } from "./useApiKeyAccess";

export function ApiKeyAccessFields({
  access,
  availableTasks,
}: {
  access: ApiKeyAccessState;
  availableTasks: string[];
}) {
  const {
    presets,
    catalogue: capabilityCatalogue,
    presetId,
    setPresetId,
    accessMode,
    setAccessMode,
    customCapabilities,
    setCustomCapabilities,
    taskScope,
    setTaskScope,
    selectedTasks,
    setSelectedTasks,
    switchToCustom,
    selectedPreset,
    showAccessControls,
    isCustom,
    hasCustomCapabilities,
    selectedPresetIsAvailable,
    usesTaskSelection,
    usesSelectedTasks,
    canManagePresets,
  } = access;
  const additionalPresetIds =
    presets
      ?.filter((preset) => !KNOWN_PRESET_IDS.has(preset.id) && preset.source !== "organization")
      .map((preset) => preset.id) ?? [];
  const organizationPresets = presets?.filter((preset) => preset.source === "organization") ?? [];
  const showTaskAccess = selectedPresetIsAvailable && usesTaskSelection;
  const selectedIsOrganizationPreset = selectedPreset?.source === "organization";
  const taskAccess = (
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
        showTaskAccess
          ? "grid-rows-[1fr] opacity-100"
          : "pointer-events-none grid-rows-[0fr] opacity-0"
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <TaskAccessPanel
          taskScope={taskScope}
          setTaskScope={setTaskScope}
          selectedTasks={selectedTasks}
          setSelectedTasks={setSelectedTasks}
          availableTasks={availableTasks}
        />
      </div>
    </div>
  );

  return (
    <>
      {showAccessControls && presets && capabilityCatalogue ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <Label>Access</Label>
            <div className="flex min-w-0 items-center gap-3">
              {capabilityCatalogue.available ? null : <CustomAccessPlanNote />}
              <SegmentedControl
                name="access-mode"
                value={accessMode}
                variant="secondary/small"
                onChange={(value) =>
                  value === "custom" ? switchToCustom() : setAccessMode("preset")
                }
                options={[
                  { label: "Preset", value: "preset" },
                  { label: "Custom", value: "custom", disabled: !capabilityCatalogue.available },
                ]}
              />
            </div>
          </div>
          {capabilityCatalogue.available ? (
            <Hint>
              Use Custom to combine presets and pick the level for each area. It starts from the
              selected preset, or empty when No restrictions is selected.
            </Hint>
          ) : null}
        </div>
      ) : null}

      {isCustom && capabilityCatalogue ? (
        <CustomCapabilityEditor
          catalogue={capabilityCatalogue}
          presets={presets}
          capabilities={customCapabilities}
          onChange={setCustomCapabilities}
          taskScope={taskScope}
          setTaskScope={setTaskScope}
          selectedTasks={selectedTasks}
          setSelectedTasks={setSelectedTasks}
          availableTasks={availableTasks}
          toolbarEnd={
            canManagePresets ? (
              <SavePresetButton
                capabilities={customCapabilities}
                limitsTasks={usesSelectedTasks}
                disabled={!capabilityCatalogue.available || !hasCustomCapabilities}
              />
            ) : null
          }
        />
      ) : showAccessControls && presets ? (
        <RadioGroup value={presetId} onValueChange={setPresetId} className="space-y-4">
          <PresetOptions presets={presets} ids={["FULL_ACCESS"]} className="grid" />
          <PresetGroup
            title="Trigger and operate tasks"
            presets={presets}
            ids={["TRIGGER_ONLY", "TASK_OPERATOR"]}
          />
          {selectedIsOrganizationPreset ? null : taskAccess}
          <PresetGroup
            title="Environment capabilities"
            presets={presets}
            ids={[
              "ENVIRONMENT_OBSERVER",
              "ENVIRONMENT_OPERATOR",
              "WEBHOOKS_ONLY",
              "WAITPOINTS_ONLY",
            ]}
          />
          <PresetGroup
            title="Deployment and configuration"
            presets={presets}
            ids={["DEPLOY_ONLY", "ENV_VARS_ONLY"]}
          />
          {additionalPresetIds.length > 0 ? (
            <PresetGroup title="Other access" presets={presets} ids={additionalPresetIds} />
          ) : null}
          {organizationPresets.length > 0 ? (
            <div className="space-y-2.5">
              <div className="text-xxs font-semibold uppercase tracking-wider text-indigo-400">
                Your presets
              </div>
              <div className="grid gap-2.5 sm:grid-cols-2">
                {organizationPresets.map((preset) => (
                  <div key={preset.id} className="relative">
                    <PresetOptions presets={[preset]} ids={[preset.id]} className="grid h-full" />
                    {canManagePresets ? <DeletePresetButton preset={preset} /> : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {selectedIsOrganizationPreset ? taskAccess : null}
        </RadioGroup>
      ) : null}
    </>
  );
}

export function ApiKeyAccessPane({ access }: { access: ApiKeyAccessState }) {
  const {
    presets,
    catalogue: capabilityCatalogue,
    customCapabilities,
    taskScope,
    selectedTasks,
    selectedPreset,
    showAccessControls,
    isCustom,
    usesSelectedTasks,
    usesTaskSelection,
  } = access;
  return isCustom && capabilityCatalogue ? (
    <CustomScopePanel
      catalogue={capabilityCatalogue}
      presets={presets}
      capabilities={customCapabilities}
      taskIdentifiers={usesSelectedTasks ? selectedTasks : undefined}
    />
  ) : showAccessControls ? (
    <ApiKeyScopePanel
      preset={selectedPreset}
      catalogue={capabilityCatalogue}
      taskIdentifiers={usesTaskSelection && taskScope === "selected" ? selectedTasks : undefined}
      showUpgradeCta={selectedPreset ? !selectedPreset.available : false}
    />
  ) : null;
}

export function ApiKeyAccessInputs({ access }: { access: ApiKeyAccessState }) {
  const { presetId, customCapabilities, taskScope, selectedTasks, isCustom, usesTaskSelection } =
    access;
  return (
    <>
      {isCustom ? (
        <>
          <input type="hidden" name="presetId" value={CUSTOM_API_KEY_PRESET_ID} />
          <input type="hidden" name="capabilities" value={JSON.stringify(customCapabilities)} />
        </>
      ) : presetId ? (
        <input type="hidden" name="presetId" value={presetId} />
      ) : null}
      {usesTaskSelection ? <input type="hidden" name="taskScope" value={taskScope} /> : null}
      {usesTaskSelection && taskScope === "selected"
        ? selectedTasks.map((taskIdentifier) => (
            <input
              key={taskIdentifier}
              type="hidden"
              name="taskIdentifiers"
              value={taskIdentifier}
            />
          ))
        : null}
    </>
  );
}

const KNOWN_PRESET_IDS = new Set([
  "FULL_ACCESS",
  "TRIGGER_ONLY",
  "TASK_OPERATOR",
  "ENVIRONMENT_OBSERVER",
  "ENVIRONMENT_OPERATOR",
  "DEPLOY_ONLY",
  "ENV_VARS_ONLY",
  "WEBHOOKS_ONLY",
  "WAITPOINTS_ONLY",
]);

function PresetGroup({
  title,
  presets,
  ids,
}: {
  title: string;
  presets: ApiKeyAccessPreset[];
  ids: string[];
}) {
  return (
    <div className="space-y-2.5">
      <div className="text-xxs font-semibold uppercase tracking-wider text-indigo-400">{title}</div>
      <PresetOptions presets={presets} ids={ids} className="grid gap-2.5 sm:grid-cols-2" />
    </div>
  );
}

function PresetOptions({
  presets,
  ids,
  className,
}: {
  presets: ApiKeyAccessPreset[];
  ids: string[];
  className?: string;
}) {
  return (
    <div className={className}>
      {ids
        .flatMap((id) => presets.filter((preset) => preset.id === id))
        .map((preset) => (
          <RadioGroupItem
            key={preset.id}
            id={`api-key-access-${preset.id}`}
            value={preset.id}
            variant="description"
            className="h-full min-h-[3.5rem] items-start border-grid-bright bg-background-bright p-3 shadow-none [&_p]:mt-0.5 [&_p]:text-xs [&_p]:leading-snug hover:border-border-bright hover:bg-background-hover data-[state=checked]:border-indigo-500/70 data-[state=checked]:bg-indigo-500/10 hover:data-[state=checked]:bg-indigo-500/15"
            label={
              preset.id === "FULL_ACCESS" ? (
                <span className="flex items-center gap-2">
                  {preset.label}
                  <span className="rounded-[3px] bg-amber-500/15 px-1.5 py-0.5 text-xxs font-semibold uppercase tracking-wide text-amber-400">
                    Full access
                  </span>
                </span>
              ) : (
                preset.label
              )
            }
            description={preset.description}
            badges={preset.available ? undefined : ["Upgrade"]}
          />
        ))}
    </div>
  );
}

function ApiKeyScopePanel({
  preset,
  catalogue,
  taskIdentifiers,
  showUpgradeCta,
}: {
  preset?: ApiKeyAccessPreset;
  catalogue: ApiKeyCapabilityCatalogue | null;
  taskIdentifiers?: string[];
  showUpgradeCta: boolean;
}) {
  const fullAccess = preset?.fullAccess ?? false;
  const capabilities = preset?.capabilities;

  return (
    <aside className="border-t border-grid-bright bg-background-deep lg:border-l lg:border-t-0">
      <div className="px-5 pb-6 pt-4 lg:sticky lg:top-0">
        {showUpgradeCta ? (
          <ApiKeyScopeUpgradeCta show />
        ) : !preset ? (
          <p className="text-xs text-text-dimmed">Pick a preset to see what this key can access.</p>
        ) : catalogue && (fullAccess || capabilities) ? (
          <CapabilityList
            catalogue={catalogue}
            capabilities={capabilities ?? {}}
            fullAccess={fullAccess}
            taskIdentifiers={taskIdentifiers}
          />
        ) : (
          <p className="text-xs text-text-dimmed">
            Scope details are unavailable for this access preset.
          </p>
        )}
      </div>
    </aside>
  );
}

function CustomScopePanel({
  catalogue,
  presets,
  capabilities,
  taskIdentifiers,
}: {
  catalogue: ApiKeyCapabilityCatalogue;
  presets: ApiKeyAccessPreset[] | null;
  capabilities: ApiKeyCapabilityMap;
  taskIdentifiers?: string[];
}) {
  const summary = summarizeCapabilities(catalogue, capabilities, presets, taskIdentifiers);

  if (!catalogue.available) {
    return (
      <aside className="border-t border-grid-bright bg-background-deep lg:border-l lg:border-t-0">
        <div className="px-5 pb-6 pt-4">
          <ApiKeyScopeUpgradeCta show />
        </div>
      </aside>
    );
  }

  return (
    <aside className="border-t border-grid-bright bg-background-deep lg:border-l lg:border-t-0">
      <div className="space-y-3 px-5 pb-6 pt-4 lg:sticky lg:top-0">
        <div className="rounded-md border border-grid-bright bg-background-bright/40 px-3 py-2 text-xs">
          {summary.match ? (
            <span className="text-text-bright">
              Matches preset: <span className="font-medium">{summary.match}</span>
            </span>
          ) : (
            <span className="text-text-bright">{summary.text}</span>
          )}
        </div>
        <CapabilityList
          catalogue={catalogue}
          capabilities={capabilities}
          taskIdentifiers={taskIdentifiers}
          showScopes
        />
      </div>
    </aside>
  );
}

function CustomAccessPlanNote() {
  const { isManagedCloud } = useFeatures();
  const organization = useOrganization();
  const showSelfServe = useShowSelfServe();

  return (
    <span className="text-right text-xs text-text-dimmed">
      {RESTRICTED_API_KEYS_PLAN_MESSAGE}
      {isManagedCloud && showSelfServe ? (
        <>
          {" "}
          <TextLink to={v3BillingPath(organization)}>View plans</TextLink>
        </>
      ) : null}
    </span>
  );
}

function ApiKeyScopeUpgradeCta({ show }: { show: boolean }) {
  const { isManagedCloud } = useFeatures();
  const organization = useOrganization();
  const showSelfServe = useShowSelfServe();

  if (!show) return null;

  if (!isManagedCloud) {
    return (
      <div className="text-right">
        <Paragraph variant="small">
          Restricted API keys aren't available on your current plan. Contact your administrator to
          enable them.
        </Paragraph>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end text-right">
      <Paragraph variant="small" className="mb-3">
        Upgrade to create restricted keys.
      </Paragraph>
      {showSelfServe ? (
        <LinkButton variant="primary/small" to={v3BillingPath(organization)}>
          View plans
        </LinkButton>
      ) : (
        <Feedback
          defaultValue="enterprise"
          button={<Button variant="secondary/small">Contact us</Button>}
        />
      )}
    </div>
  );
}

function TaskAccessPanel({
  taskScope,
  setTaskScope,
  selectedTasks,
  setSelectedTasks,
  availableTasks,
}: {
  taskScope: TaskScope;
  setTaskScope: (value: TaskScope) => void;
  selectedTasks: string[];
  setSelectedTasks: (value: string[]) => void;
  availableTasks: string[];
}) {
  return (
    <div className="rounded-md border border-grid-bright bg-background-bright/40 p-3.5">
      <div className="text-2sm font-medium text-text-bright">Task access</div>
      <TaskScopeControl
        taskScope={taskScope}
        setTaskScope={setTaskScope}
        selectedTasks={selectedTasks}
        setSelectedTasks={setSelectedTasks}
        availableTasks={availableTasks}
        className="mt-3 min-h-[5.5rem]"
      />
    </div>
  );
}

function SavePresetButton({
  capabilities,
  limitsTasks,
  disabled,
}: {
  capabilities: ApiKeyCapabilityMap;
  limitsTasks: boolean;
  disabled: boolean;
}) {
  const fetcher = useTypedFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const result =
    submitted && fetcher.state === "idle"
      ? (fetcher.data as ApiKeyActionData | undefined)
      : undefined;
  const isOpen = open && !result?.ok;
  const error = result && !result.ok ? result.error : undefined;

  function save() {
    if (!name.trim() || fetcher.state !== "idle") return;
    setSubmitted(true);
    fetcher.submit(
      {
        action: "save-preset",
        name,
        description,
        capabilities: JSON.stringify(capabilities),
        limitsTasks: String(limitsTasks),
      },
      { method: "post" }
    );
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    save();
  }

  return (
    <Popover
      open={isOpen}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setSubmitted(false);
          setName("");
          setDescription("");
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="secondary/small" disabled={disabled}>
          Save as preset
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-3 p-3" align="end">
        <InputGroup fullWidth>
          <Label htmlFor="api-key-preset-name">Preset name</Label>
          <Input
            id="api-key-preset-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onKeyDown}
            maxLength={64}
            placeholder="e.g. CI deploy and smoke"
            autoComplete="off"
            autoFocus
            fullWidth
          />
        </InputGroup>
        <InputGroup fullWidth>
          <Label htmlFor="api-key-preset-description">Description (optional)</Label>
          <Input
            id="api-key-preset-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            onKeyDown={onKeyDown}
            maxLength={200}
            autoComplete="off"
            fullWidth
          />
        </InputGroup>
        <Paragraph variant="extra-small" className="text-text-dimmed">
          {limitsTasks
            ? "Saved for everyone in this organization. Keys made from it ask for tasks each time."
            : "Saved for everyone in this organization. Tasks are chosen for each key."}
        </Paragraph>
        {error ? (
          <Paragraph variant="extra-small" className="text-error">
            {error}
          </Paragraph>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="tertiary/small" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary/small"
            disabled={!name.trim()}
            isLoading={fetcher.state !== "idle"}
            onClick={save}
          >
            Save preset
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function DeletePresetButton({ preset }: { preset: ApiKeyAccessPreset }) {
  const fetcher = useTypedFetcher<typeof action>();
  const [open, setOpen] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const result =
    submitted && fetcher.state === "idle"
      ? (fetcher.data as ApiKeyActionData | undefined)
      : undefined;
  const error = result && !result.ok ? result.error : undefined;

  return (
    <Popover
      open={open && !result?.ok}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setSubmitted(false);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Delete ${preset.label}`}
          className="absolute right-2 top-2 rounded p-1 text-text-dimmed transition hover:bg-background-hover hover:text-error"
        >
          <TrashIcon className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2 p-3" align="end">
        <div className="text-sm text-text-bright">Delete {preset.label}?</div>
        <Paragraph variant="extra-small" className="text-text-dimmed">
          Keys created from this preset keep their access.
        </Paragraph>
        {error ? (
          <Paragraph variant="extra-small" className="text-error">
            {error}
          </Paragraph>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="tertiary/small" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger/small"
            isLoading={fetcher.state !== "idle"}
            onClick={() => {
              setSubmitted(true);
              fetcher.submit({ action: "delete-preset", presetId: preset.id }, { method: "post" });
            }}
          >
            Delete preset
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
