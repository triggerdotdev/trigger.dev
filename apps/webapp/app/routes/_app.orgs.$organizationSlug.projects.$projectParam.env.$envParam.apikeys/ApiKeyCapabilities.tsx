import {
  type ApiKeyCapability,
  type ApiKeyCapabilityCatalogue,
  type ApiKeyCapabilityMap,
  applyApiKeyCapabilityRequirements,
  mergeApiKeyCapabilities,
  NO_ACCESS_LEVEL_ID,
  restrictScopeToTasks,
} from "@trigger.dev/plugins";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "~/components/primitives/Popover";
import SegmentedControl from "~/components/primitives/SegmentedControl";
import { Select, SelectItem } from "~/components/primitives/Select";
import {
  type CapabilityPreset,
  capabilityLabel,
  capabilityPresets,
  customCapabilitiesAfterChange,
  customKeyUsesSelectedTasks,
  isGranted,
  type Presets,
  taskAccessAfterPreset,
  type TaskScope,
} from "~/utils/apiKeyAccess";
import { cn } from "~/utils/cn";

function levelTone(levelId: string | undefined): "none" | "read" | "write" {
  if (!levelId || levelId === NO_ACCESS_LEVEL_ID) return "none";
  return levelId === "read" ? "read" : "write";
}

function shownScopes(
  capability: ApiKeyCapability,
  scopes: string[],
  taskIdentifiers?: string[]
): string[] {
  if (capability.taskSelection?.kind !== "scoped" || !taskIdentifiers?.length) return scopes;
  const shownTasks = taskIdentifiers.slice(0, 3);
  return scopes.flatMap((scope) => {
    const restricted = restrictScopeToTasks(scope, shownTasks);
    if (restricted.length > 1 && taskIdentifiers.length > shownTasks.length) {
      restricted.push(`… +${taskIdentifiers.length - shownTasks.length} more`);
    }
    return restricted;
  });
}

export function CapabilityList({
  catalogue,
  capabilities,
  fullAccess = false,
  grantedOnly = false,
  unmatchedScopes,
  showScopes = false,
  taskIdentifiers,
}: {
  catalogue: ApiKeyCapabilityCatalogue;
  capabilities: ApiKeyCapabilityMap;
  fullAccess?: boolean;
  grantedOnly?: boolean;
  unmatchedScopes?: string[];
  showScopes?: boolean;
  taskIdentifiers?: string[];
}) {
  const rows = catalogue.capabilities
    .map((capability) => {
      const levelId = fullAccess ? undefined : capabilities[capability.id];
      const level = capability.levels.find((candidate) => candidate.id === levelId);
      return { capability, level, tone: fullAccess ? "write" : levelTone(levelId) } as const;
    })
    .filter((row) => !grantedOnly || row.tone !== "none");

  return (
    <ul className="flex flex-col">
      {rows.map(({ capability, level, tone }) => (
        <li key={capability.id} className="border-t border-grid-dimmed py-1.5 first:border-t-0">
          <div className="flex items-baseline gap-2.5">
            <span
              className={cn(
                "mt-1.5 size-1.5 shrink-0 rounded-[2px]",
                tone === "read"
                  ? "bg-blue-500"
                  : tone === "write"
                    ? "bg-amber-500"
                    : "bg-text-dimmed"
              )}
            />
            <span
              className={cn(
                "min-w-0 flex-1 text-xs",
                tone === "none" ? "text-text-dimmed" : "text-text-bright"
              )}
            >
              {capabilityLabel(capability, taskIdentifiers)}
            </span>
            <span className="whitespace-nowrap text-xs text-text-dimmed">
              {fullAccess ? "Full access" : (level?.label ?? "None")}
            </span>
          </div>
          {showScopes && level && level.scopes.length > 0 ? (
            <div className="ml-4 mt-1 flex flex-col gap-0.5">
              {shownScopes(capability, level.scopes, taskIdentifiers).map((scope) => (
                <code
                  key={scope}
                  className={cn(
                    "break-all font-mono text-xxs leading-relaxed",
                    scope.startsWith("…")
                      ? "text-text-dimmed"
                      : scope.startsWith("read:")
                        ? "text-blue-400/80"
                        : "text-amber-400/80"
                  )}
                >
                  {scope}
                </code>
              ))}
            </div>
          ) : null}
        </li>
      ))}
      {unmatchedScopes && unmatchedScopes.length > 0 ? (
        <li className="border-t border-grid-dimmed py-1.5">
          <div className="text-xs text-text-bright">Other scopes</div>
          <div className="mt-1 flex flex-col gap-0.5">
            {unmatchedScopes.map((scope) => (
              <code key={scope} className="break-all font-mono text-xxs text-text-dimmed">
                {scope}
              </code>
            ))}
          </div>
        </li>
      ) : null}
    </ul>
  );
}

export function CustomCapabilityEditor({
  catalogue,
  presets,
  capabilities,
  onChange,
  taskScope,
  setTaskScope,
  selectedTasks,
  setSelectedTasks,
  availableTasks,
  toolbarEnd,
}: {
  catalogue: ApiKeyCapabilityCatalogue;
  presets: Presets;
  capabilities: ApiKeyCapabilityMap;
  onChange: (capabilities: ApiKeyCapabilityMap) => void;
  toolbarEnd?: ReactNode;
  taskScope: TaskScope;
  setTaskScope: (value: TaskScope) => void;
  selectedTasks: string[];
  setSelectedTasks: (value: string[]) => void;
  availableTasks: string[];
}) {
  const usesSelectedTasks = customKeyUsesSelectedTasks(catalogue, capabilities, taskScope);
  const { requirements } = applyApiKeyCapabilityRequirements(catalogue.capabilities, capabilities);
  const apply = (next: ApiKeyCapabilityMap, nextScope: TaskScope = taskScope) => {
    onChange(customCapabilitiesAfterChange(catalogue, next, nextScope));
  };
  const pickPreset = (
    preset: CapabilityPreset,
    next: ApiKeyCapabilityMap,
    how: "replace" | "add"
  ) => {
    const taskAccess = taskAccessAfterPreset(preset, { taskScope, selectedTasks }, how);
    setTaskScope(taskAccess.taskScope);
    setSelectedTasks(taskAccess.selectedTasks);
    apply(next, taskAccess.taskScope);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <PresetMenu
          label="Start from"
          presets={presets}
          onPick={(preset) => pickPreset(preset, preset.capabilities, "replace")}
        />
        <PresetMenu
          label="Add preset"
          presets={presets}
          onPick={(preset) =>
            pickPreset(
              preset,
              mergeApiKeyCapabilities(catalogue.capabilities, capabilities, preset.capabilities),
              "add"
            )
          }
        />
        <span className="mx-1 h-4 w-px bg-grid-bright" />
        <Button type="button" variant="minimal/small" onClick={() => onChange({})}>
          Clear all
        </Button>
        {toolbarEnd ? <div className="ml-auto">{toolbarEnd}</div> : null}
      </div>
      <ul className="flex flex-col rounded-md border border-grid-bright">
        {catalogue.capabilities.map((capability) => {
          const notes = requirements.filter(
            (requirement) => requirement.capabilityId === capability.id
          );
          const selection = capability.taskSelection;
          const granted = isGranted(capabilities, capability.id);
          const unavailable = usesSelectedTasks && selection?.kind === "unavailable";
          return (
            <li
              key={capability.id}
              className="flex flex-col gap-1 border-t border-grid-dimmed px-3 py-2 first:border-t-0"
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "min-w-0 flex-1 text-sm",
                    unavailable ? "text-text-dimmed" : "text-text-bright"
                  )}
                >
                  {capability.label}
                </span>
                {unavailable ? (
                  <span className="text-xs text-text-dimmed">Unavailable with selected tasks</span>
                ) : (
                  <SegmentedControl
                    name={`capability-${capability.id}`}
                    value={capabilities[capability.id] ?? NO_ACCESS_LEVEL_ID}
                    variant="secondary/small"
                    options={capability.levels.map((level) => ({
                      label: level.label,
                      value: level.id,
                    }))}
                    onChange={(levelId) => apply({ ...capabilities, [capability.id]: levelId })}
                  />
                )}
              </div>
              {capability.hint ? (
                <span className="text-xs text-text-dimmed">{capability.hint}</span>
              ) : null}
              {selection?.kind === "scoped" && granted ? (
                <TaskScopeControl
                  taskScope={taskScope}
                  setTaskScope={(value) => {
                    setTaskScope(value);
                    apply(capabilities, value);
                  }}
                  selectedTasks={selectedTasks}
                  setSelectedTasks={setSelectedTasks}
                  availableTasks={availableTasks}
                  className="mt-1"
                />
              ) : null}
              {unavailable ? (
                <span className="text-xs text-text-dimmed">{selection.reason}</span>
              ) : null}
              {usesSelectedTasks && !selection && granted ? (
                <span className="text-xs text-text-dimmed">Applies to the whole environment</span>
              ) : null}
              {notes.map((note) => (
                <span key={note.requiredBy} className="text-xs text-text-dimmed">
                  Needed by{" "}
                  {catalogue.capabilities.find((c) => c.id === note.requiredBy)?.label ??
                    note.requiredBy}
                  . {note.note}
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function TaskScopeControl({
  taskScope,
  setTaskScope,
  selectedTasks,
  setSelectedTasks,
  availableTasks,
  className,
}: {
  taskScope: TaskScope;
  setTaskScope: (value: TaskScope) => void;
  selectedTasks: string[];
  setSelectedTasks: (value: string[]) => void;
  availableTasks: string[];
  className?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    if (!pickerOpen) return;
    const closePicker = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setPickerOpen(false);
    };
    window.addEventListener("keydown", closePicker, true);
    return () => window.removeEventListener("keydown", closePicker, true);
  }, [pickerOpen]);

  return (
    <div className={className}>
      <SegmentedControl
        name="task-scope"
        value={taskScope}
        onChange={(value) => setTaskScope(value as TaskScope)}
        fullWidth
        options={[
          { label: "All tasks", value: "all" },
          { label: "Selected tasks", value: "selected" },
        ]}
      />
      {taskScope === "selected" ? (
        <Select<string[], string>
          open={pickerOpen}
          setOpen={setPickerOpen}
          value={selectedTasks}
          setValue={setSelectedTasks}
          placeholder="Choose tasks"
          text={(tasks) =>
            tasks.length === 0
              ? undefined
              : `${tasks.length} selected ${tasks.length === 1 ? "task" : "tasks"}`
          }
          variant="secondary/medium"
          dropdownIcon
          items={availableTasks}
          filter
          heading="Search tasks"
          empty={
            <div className="p-3 text-xs text-text-dimmed">
              {availableTasks.length === 0
                ? "No tasks deployed to this environment yet. Deploy once, then pick tasks here."
                : "No tasks found."}
            </div>
          }
          className="mt-2 w-full justify-between"
          popoverClassName="max-h-64"
        >
          {(tasks) =>
            tasks.map((taskIdentifier) => (
              <SelectItem key={taskIdentifier} value={taskIdentifier} checkPosition="left">
                <span className="font-mono text-text-bright">{taskIdentifier}</span>
              </SelectItem>
            ))
          }
        </Select>
      ) : null}
    </div>
  );
}

function PresetMenu({
  label,
  presets,
  onPick,
}: {
  label: string;
  presets: Presets;
  onPick: (preset: CapabilityPreset) => void;
}) {
  const [open, setOpen] = useState(false);
  const withCapabilities = capabilityPresets(presets);
  const builtIn = withCapabilities.filter((preset) => preset.source !== "organization");
  const organization = withCapabilities.filter((preset) => preset.source === "organization");
  const item = (preset: CapabilityPreset) => (
    <PopoverMenuItem
      key={preset.id}
      type="button"
      title={preset.label}
      onClick={() => {
        onPick(preset);
        setOpen(false);
      }}
    />
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverArrowTrigger isOpen={open} className="border border-grid-bright">
        {label}
      </PopoverArrowTrigger>
      <PopoverContent
        className="flex w-64 min-w-0 flex-col overflow-y-auto p-1 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-surface-control"
        style={{ maxHeight: "min(24rem, var(--radix-popover-content-available-height))" }}
        align="start"
      >
        {builtIn.map(item)}
        {organization.length > 0 ? (
          <>
            <PopoverSectionHeader title="Your presets" />
            {organization.map(item)}
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
