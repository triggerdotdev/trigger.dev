import {
  type ApiKeyCapability,
  type ApiKeyCapabilityCatalogue,
  type ApiKeyCapabilityMap,
  applyApiKeyCapabilityRequirements,
  mergeApiKeyCapabilities,
  NO_ACCESS_LEVEL_ID,
  restrictScopeToTasks,
} from "@trigger.dev/plugins";
import { LockClosedIcon } from "@heroicons/react/20/solid";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { AnimatePresence, motion } from "framer-motion";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { Hint } from "~/components/primitives/Hint";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Popover,
  PopoverArrowTrigger,
  PopoverContent,
  PopoverMenuItem,
  PopoverSectionHeader,
} from "~/components/primitives/Popover";
import { RadioButtonCircle } from "~/components/primitives/RadioButton";
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
  notes,
}: {
  catalogue: ApiKeyCapabilityCatalogue;
  capabilities: ApiKeyCapabilityMap;
  fullAccess?: boolean;
  grantedOnly?: boolean;
  unmatchedScopes?: string[];
  showScopes?: boolean;
  taskIdentifiers?: string[];
  notes?: Record<string, ReactNode>;
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
          {notes?.[capability.id] ? (
            <div className="ml-4 mt-0.5 text-xs text-text-dimmed">{notes[capability.id]}</div>
          ) : null}
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

// Access levels shown as columns of the custom access table, in order. An area with any other
// level (Tasks) keeps a segmented control above the table.
const TABLE_LEVEL_IDS = [NO_ACCESS_LEVEL_ID, "read", "readWrite", "manage"];

// A radio that can't be chosen: dashed outline, no fill, faded, and a grey dot when it's the
// current level, so it doesn't read as a choice.
const DISABLED_RADIO = {
  boxClassName: "border-dashed bg-transparent opacity-60",
  outerCircleClassName: "border-transparent bg-transparent",
  innerCircleClassName:
    "fill-text-dimmed text-text-dimmed dark:fill-text-dimmed dark:text-text-dimmed",
};

/**
 * The levels an area is limited to because of other areas' current levels, e.g. Deployments read
 * and write needs Environment variables read and write. Areas with no such limit are absent.
 */
function requiredLevels(
  catalogue: ApiKeyCapability[],
  capabilities: ApiKeyCapabilityMap
): Map<string, Set<string>> {
  const allowed = new Map<string, Set<string>>();
  for (const capability of catalogue) {
    const level = capability.levels.find((l) => l.id === capabilities[capability.id]);
    for (const requirement of level?.requires ?? []) {
      const current = allowed.get(requirement.capabilityId);
      allowed.set(
        requirement.capabilityId,
        new Set(requirement.levelIds.filter((id) => !current || current.has(id)))
      );
    }
  }
  return allowed;
}

function fitsAccessTable(capability: ApiKeyCapability): boolean {
  return capability.levels.every((level) => TABLE_LEVEL_IDS.includes(level.id));
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

  const hasAnyAccess = Object.values(capabilities).some(
    (levelId) => levelId !== NO_ACCESS_LEVEL_ID
  );
  const tableCapabilities = catalogue.capabilities.filter(fitsAccessTable);
  const otherCapabilities = catalogue.capabilities.filter(
    (capability) => !fitsAccessTable(capability)
  );
  const columns = TABLE_LEVEL_IDS.flatMap((id) => {
    const level = tableCapabilities
      .flatMap((capability) => capability.levels)
      .find((l) => l.id === id);
    return level ? [{ id, label: level.label }] : [];
  });
  const tableGrid = { gridTemplateColumns: `minmax(0, 1fr) repeat(${columns.length}, 5.5rem)` };

  const allowedLevels = requiredLevels(catalogue.capabilities, capabilities);
  const details = (capability: ApiKeyCapability) => {
    const selection = capability.taskSelection;
    const granted = isGranted(capabilities, capability.id);
    const unavailable = usesSelectedTasks && selection?.kind === "unavailable";
    const notes: CapabilityNote[] = [
      ...(unavailable
        ? [
            {
              key: "unavailable",
              text: `Unavailable with selected tasks. ${selection.reason}`,
              locked: true,
            },
          ]
        : []),
      ...(usesSelectedTasks && !selection && granted
        ? [{ key: "whole-environment", text: "Applies to the whole environment" }]
        : []),
      ...requirements
        .filter((requirement) => requirement.capabilityId === capability.id)
        .map((note) => ({
          key: `needed-by-${note.requiredBy}`,
          locked: true,
          text: `Needed by ${
            catalogue.capabilities.find((c) => c.id === note.requiredBy)?.label ?? note.requiredBy
          }. ${note.note}`,
        })),
    ];
    const allowed = allowedLevels.get(capability.id);
    // A level can't be picked when task selection rules the area out, or when another area's level
    // needs this one at a different level (the editor would change it straight back).
    const canPick = (levelId: string) => !unavailable && (!allowed || allowed.has(levelId));
    return { selection, granted, unavailable, notes, canPick };
  };
  const setLevel = (capability: ApiKeyCapability, levelId: string) =>
    apply({ ...capabilities, [capability.id]: levelId });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <PresetMenu
            label="Start from"
            heading="Replaces the current access"
            presets={presets}
            onPick={(preset) => pickPreset(preset, preset.capabilities, "replace")}
          />
          <PresetMenu
            label="Add preset"
            heading="Adds to the current access"
            presets={presets}
            onPick={(preset) =>
              pickPreset(
                preset,
                mergeApiKeyCapabilities(catalogue.capabilities, capabilities, preset.capabilities),
                "add"
              )
            }
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="minimal/small"
            disabled={!hasAnyAccess}
            onClick={() => onChange({})}
          >
            Clear all
          </Button>
          {toolbarEnd}
        </div>
      </div>
      <div className="rounded-md border border-grid-bright">
        {otherCapabilities.map((capability) => {
          const { selection, granted, unavailable, notes, canPick } = details(capability);
          const control = (
            <SegmentedControl
              name={`capability-${capability.id}`}
              value={capabilities[capability.id] ?? NO_ACCESS_LEVEL_ID}
              variant="secondary/small"
              className="shrink-0"
              options={capability.levels.map((level) => ({
                label: level.label,
                value: level.id,
                disabled: !canPick(level.id),
              }))}
              onChange={(levelId) => setLevel(capability, levelId)}
            />
          );
          const label = (
            <Paragraph variant={unavailable ? "small" : "small/bright"}>
              {capability.label}
            </Paragraph>
          );
          return (
            <div key={capability.id} className="border-b border-grid-dimmed px-3 py-2.5">
              {/* Like the Access header: the control sits beside the description. */}
              {capability.hint ? (
                <>
                  {label}
                  <div className="flex items-center justify-between gap-6">
                    <Hint>{capability.hint}</Hint>
                    {control}
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-between gap-6">
                  {label}
                  {control}
                </div>
              )}
              <CapabilityNotes notes={notes} className="pt-2" />
              <Reveal show={selection?.kind === "scoped" && granted}>
                <TaskScopeControl
                  taskScope={taskScope}
                  setTaskScope={(value) => {
                    setTaskScope(value);
                    apply(capabilities, value);
                  }}
                  selectedTasks={selectedTasks}
                  setSelectedTasks={setSelectedTasks}
                  availableTasks={availableTasks}
                  label={<TaskAccessLabel />}
                  className="mt-2.5 border-t border-grid-dimmed pt-2.5"
                />
              </Reveal>
            </div>
          );
        })}
        {tableCapabilities.length > 0 ? (
          <div role="group" aria-label="Access by area">
            <div
              className="grid items-center border-b border-grid-dimmed px-3 py-1.5 text-xs text-text-dimmed"
              style={tableGrid}
              aria-hidden
            >
              <span>Area</span>
              {columns.map((column) => (
                <span key={column.id} className="text-center">
                  {column.label}
                </span>
              ))}
            </div>
            {tableCapabilities.map((capability) => {
              const { unavailable, notes, canPick } = details(capability);
              const value = capabilities[capability.id] ?? NO_ACCESS_LEVEL_ID;
              const labelId = `api-key-capability-${capability.id}`;
              return (
                <RadioGroupPrimitive.Root
                  key={capability.id}
                  value={value}
                  onValueChange={(levelId) => setLevel(capability, levelId)}
                  orientation="horizontal"
                  aria-labelledby={labelId}
                  disabled={unavailable}
                  className="grid items-center border-b border-grid-dimmed px-3 last:border-b-0"
                  style={tableGrid}
                >
                  <div className="min-w-0 py-2">
                    <Paragraph id={labelId} variant={unavailable ? "small" : "small/bright"}>
                      {capability.label}
                    </Paragraph>
                    <CapabilityNotes notes={notes} className="pt-0.5" />
                  </div>
                  {columns.map((column) => {
                    const level = capability.levels.find((l) => l.id === column.id);
                    const disabled = level ? !canPick(level.id) : true;
                    return level ? (
                      <RadioGroupPrimitive.Item
                        key={column.id}
                        value={level.id}
                        disabled={disabled}
                        aria-label={`${capability.label}: ${level.label}`}
                        className={cn(
                          "flex items-center justify-center self-stretch rounded focus-custom",
                          disabled ? "cursor-not-allowed" : "cursor-pointer"
                        )}
                      >
                        <RadioButtonCircle
                          checked={value === level.id}
                          {...(disabled ? DISABLED_RADIO : {})}
                        />
                      </RadioGroupPrimitive.Item>
                    ) : (
                      <span key={column.id} />
                    );
                  })}
                </RadioGroupPrimitive.Root>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Opens by height and fades, so content below moves smoothly instead of jumping. It's clipped only
// while it moves, so focus rings inside aren't cut off.
const REVEAL_MOTION = {
  initial: { height: 0, opacity: 0, overflow: "hidden" },
  animate: { height: "auto", opacity: 1, transitionEnd: { overflow: "visible" } },
  exit: { height: 0, opacity: 0, overflow: "hidden" },
  transition: { duration: 0.2, ease: "easeOut" },
} as const;

function Reveal({ show, children }: { show: boolean; children: ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {show ? <motion.div {...REVEAL_MOTION}>{children}</motion.div> : null}
    </AnimatePresence>
  );
}

/** `locked`: the note explains why some of this area's levels are disabled. */
type CapabilityNote = { key: string; text: string; locked?: boolean };

/** Notes under an area's name. Each one opens and closes on its own. */
function CapabilityNotes({ notes, className }: { notes: CapabilityNote[]; className?: string }) {
  return (
    <AnimatePresence initial={false}>
      {notes.map((note) => (
        <motion.div key={note.key} {...REVEAL_MOTION}>
          <div className={cn("flex items-start gap-1.5", className)}>
            {note.locked ? (
              <LockClosedIcon className="mt-px size-3 shrink-0 text-text-dimmed" aria-hidden />
            ) : null}
            <Hint>{note.text}</Hint>
          </div>
        </motion.div>
      ))}
    </AnimatePresence>
  );
}

/** Label for the All tasks/Selected tasks row, shared by preset and custom access. */
export function TaskAccessLabel() {
  return (
    <div className="min-w-0">
      <Paragraph variant="small/bright">Task access</Paragraph>
      <Hint>Choose which tasks this key can access.</Hint>
    </div>
  );
}

export function TaskScopeControl({
  taskScope,
  setTaskScope,
  selectedTasks,
  setSelectedTasks,
  availableTasks,
  label,
  className,
}: {
  taskScope: TaskScope;
  setTaskScope: (value: TaskScope) => void;
  selectedTasks: string[];
  setSelectedTasks: (value: string[]) => void;
  availableTasks: string[];
  /** Shown on the left of the toggle row. */
  label?: ReactNode;
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
      <div className={cn("flex items-center gap-4", label && "justify-between")}>
        {label}
        <SegmentedControl
          name="task-scope"
          value={taskScope}
          variant="secondary/small"
          className="shrink-0"
          onChange={(value) => setTaskScope(value as TaskScope)}
          options={[
            { label: "All tasks", value: "all" },
            { label: "Selected tasks", value: "selected" },
          ]}
        />
      </div>
      <Reveal show={taskScope === "selected"}>
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
          className="mt-3 w-full justify-between"
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
      </Reveal>
    </div>
  );
}

function PresetMenu({
  label,
  heading,
  presets,
  onPick,
}: {
  label: string;
  /** What picking a preset does, shown at the top of the menu. */
  heading: string;
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
        <PopoverSectionHeader title={heading} />
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
