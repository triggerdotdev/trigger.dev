import {
  type ApiKeyCapability,
  type ApiKeyCapabilityCatalogue,
  type ApiKeyCapabilityDifference,
  type ApiKeyCapabilityMap,
  type ApiKeyPreset,
  apiKeyCapabilitiesEqual,
  applyApiKeyCapabilityRequirements,
  CUSTOM_API_KEY_PRESET_ID,
  FULL_ACCESS_PRESET_ID,
  mergeApiKeyCapabilities,
  NO_ACCESS_LEVEL_ID,
  restrictScopeToTasks,
  withoutTaskSelectionUnavailable,
} from "@trigger.dev/plugins";

export type ApiKeyAccessPreset = Omit<ApiKeyPreset, "scopes"> & { fullAccess: boolean };

export type Presets = ApiKeyAccessPreset[] | null | undefined;

export type CapabilityPreset = ApiKeyAccessPreset & { capabilities: ApiKeyCapabilityMap };

export type TaskScope = "all" | "selected";

export type InitialApiKeyAccess = {
  mode: "preset" | "custom";
  presetId: string;
  capabilities: ApiKeyCapabilityMap;
  taskScope: TaskScope;
  tasks: string[];
};

export type StoredApiKeyAccess = {
  presetId: string | null;
  fullAccess: boolean;
  matchesPreset: boolean;
  capabilities?: ApiKeyCapabilityMap;
  taskIdentifiers?: string[];
};

export function initialApiKeyAccess(
  apiKey: StoredApiKeyAccess,
  presets: Presets,
  defaultPresetId: string,
  startFromPreset = false
): InitialApiKeyAccess {
  const tasks = apiKey.taskIdentifiers ?? [];
  const taskScope: TaskScope = tasks.length > 0 ? "selected" : "all";
  if (apiKey.fullAccess) {
    return { mode: "preset", presetId: FULL_ACCESS_PRESET_ID, capabilities: {}, taskScope, tasks };
  }
  const knownPresetId =
    apiKey.presetId !== null &&
    apiKey.presetId !== CUSTOM_API_KEY_PRESET_ID &&
    presets?.some((preset) => preset.id === apiKey.presetId)
      ? apiKey.presetId
      : undefined;
  if (knownPresetId && (apiKey.matchesPreset || startFromPreset)) {
    return { mode: "preset", presetId: knownPresetId, capabilities: {}, taskScope, tasks };
  }
  return {
    mode: "custom",
    presetId: knownPresetId ?? defaultPresetId,
    capabilities: apiKey.capabilities ?? {},
    taskScope,
    tasks,
  };
}

export const MISSING_API_KEY_MESSAGE =
  "This key no longer exists. Reload the page to see your current keys.";
export const REVOKED_API_KEY_MESSAGE = "This key was revoked, so its access can't be changed.";
export const EXPIRED_API_KEY_MESSAGE = "This key has expired. Create a new key instead.";

export const DISABLE_ROOT_API_KEY_VISIBILITY_CONFIRMATION = "disable root key visibility";

export function uneditableApiKeyMessage(
  apiKey: { revokedAt: Date | string | null; expiresAt: Date | string | null } | undefined,
  now: number
): string | undefined {
  if (!apiKey || apiKey.revokedAt) return REVOKED_API_KEY_MESSAGE;
  if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= now) {
    return EXPIRED_API_KEY_MESSAGE;
  }
  return undefined;
}

export type ChosenPreset = { id: string; label?: string };

export function chosenPreset(presets: Presets, id: string): ChosenPreset {
  return { id, label: presets?.find((preset) => preset.id === id)?.label };
}

export function resolvePresetSelection(
  presets: Presets,
  chosen: ChosenPreset,
  defaultPresetId: string
): { presetId: string; deletedPresetLabel?: string } {
  if (!presets) return { presetId: defaultPresetId };
  if (presets.some((preset) => preset.id === chosen.id)) return { presetId: chosen.id };
  if (chosen.label === undefined) return { presetId: defaultPresetId };
  return { presetId: "", deletedPresetLabel: chosen.label };
}

export function capabilityPresets(presets: Presets): CapabilityPreset[] {
  return (presets ?? []).filter((preset): preset is CapabilityPreset => !!preset.capabilities);
}

function contains(
  catalogue: ApiKeyCapabilityCatalogue,
  outer: ApiKeyCapabilityMap,
  inner: ApiKeyCapabilityMap
) {
  return apiKeyCapabilitiesEqual(
    mergeApiKeyCapabilities(catalogue.capabilities, outer, inner),
    outer
  );
}

function taskListLabel(taskIdentifiers: string[]): string {
  if (taskIdentifiers.length <= 2) return taskIdentifiers.join(", ");
  return `${taskIdentifiers.slice(0, 2).join(", ")} +${taskIdentifiers.length - 2}`;
}

export function isGranted(capabilities: ApiKeyCapabilityMap, id: string) {
  return (capabilities[id] ?? NO_ACCESS_LEVEL_ID) !== NO_ACCESS_LEVEL_ID;
}

export function capabilityLabel(
  capability: ApiKeyCapability,
  taskIdentifiers?: string[],
  { allTasks = false }: { allTasks?: boolean } = {}
) {
  return capability.taskSelection?.kind === "scoped" &&
    taskIdentifiers &&
    taskIdentifiers.length > 0
    ? `${capability.label} (${allTasks ? taskIdentifiers.join(", ") : taskListLabel(taskIdentifiers)})`
    : capability.label;
}

/** Shown instead of "No access" when a key's only scopes are ones no access level covers. */
export const OTHER_SCOPES_ONLY_LABEL = "Scopes outside the levels";

export const OTHER_SCOPES_NOTE = "Not covered by any level. Editing access removes them.";

// More extra areas than this read better as a count than as a list.
const MAX_LISTED_EXTRAS = 3;

export function summarizeCapabilities(
  catalogue: ApiKeyCapabilityCatalogue,
  capabilities: ApiKeyCapabilityMap,
  presets: Presets,
  taskIdentifiers?: string[],
  unmatchedScopes?: string[]
): { match?: string; text: string; listsRows?: boolean; basedOn?: string } {
  const granted = catalogue.capabilities.filter((capability) =>
    isGranted(capabilities, capability.id)
  );
  if (granted.length === 0) {
    return { text: unmatchedScopes?.length ? OTHER_SCOPES_ONLY_LABEL : "No access" };
  }

  const scopedIds = new Set(
    catalogue.capabilities
      .filter((capability) => capability.taskSelection?.kind === "scoped")
      .map((capability) => capability.id)
  );
  const tasksSuffix =
    taskIdentifiers && taskIdentifiers.length > 0 ? ` (${taskListLabel(taskIdentifiers)})` : "";
  const labelFor = (preset: CapabilityPreset) =>
    preset.label +
    (Object.keys(preset.capabilities).some((id) => scopedIds.has(id)) ? tasksSuffix : "");

  const builtIn = capabilityPresets(presets).filter((preset) => preset.source !== "organization");
  const exact = builtIn.find((preset) =>
    apiKeyCapabilitiesEqual(preset.capabilities, capabilities)
  );
  if (exact) {
    const label = labelFor(exact);
    return { match: label, text: label };
  }

  const contained = builtIn.filter((preset) =>
    contains(catalogue, capabilities, preset.capabilities)
  );
  const pair = contained
    .flatMap((a, i) => contained.slice(i + 1).map((b) => [a, b] as const))
    .find(([a, b]) =>
      apiKeyCapabilitiesEqual(
        mergeApiKeyCapabilities(catalogue.capabilities, a.capabilities, b.capabilities),
        capabilities
      )
    );
  if (pair) {
    return { text: `${labelFor(pair[0])} + ${labelFor(pair[1])}` };
  }

  return {
    listsRows: true,
    basedOn: basedOnPreset(catalogue, capabilities, contained, labelFor, taskIdentifiers),
    text: granted
      .map((capability) => {
        const level = capability.levels.find((l) => l.id === capabilities[capability.id]);
        return `${capabilityLabel(capability, taskIdentifiers)}: ${level?.label.toLowerCase() ?? "?"}`;
      })
      .join(", "),
  };
}

/**
 * The built-in preset covering the most areas, plus what the key adds on top, e.g. "Operator, plus
 * Deployments: Read and write and Env vars: Read".
 */
function basedOnPreset(
  catalogue: ApiKeyCapabilityCatalogue,
  capabilities: ApiKeyCapabilityMap,
  contained: CapabilityPreset[],
  labelFor: (preset: CapabilityPreset) => string,
  taskIdentifiers?: string[]
): string | undefined {
  const grantedCount = (map: ApiKeyCapabilityMap) =>
    catalogue.capabilities.filter((capability) => isGranted(map, capability.id)).length;
  const base = contained.reduce<CapabilityPreset | undefined>(
    (best, preset) =>
      !best || grantedCount(preset.capabilities) > grantedCount(best.capabilities) ? preset : best,
    undefined
  );
  if (!base) return undefined;

  const extras = catalogue.capabilities.flatMap((capability) => {
    const levelId = capabilities[capability.id] ?? NO_ACCESS_LEVEL_ID;
    if (levelId === (base.capabilities[capability.id] ?? NO_ACCESS_LEVEL_ID)) return [];
    const level = capability.levels.find((l) => l.id === levelId);
    return [`${capabilityLabel(capability, taskIdentifiers)}: ${level?.label ?? levelId}`];
  });
  // The base must keep at least one of its areas as it is, or naming it says nothing.
  const keepsBaseArea = catalogue.capabilities.some(
    (capability) =>
      isGranted(base.capabilities, capability.id) &&
      capabilities[capability.id] === base.capabilities[capability.id]
  );
  if (extras.length === 0 || !keepsBaseArea) return undefined;
  return extras.length > MAX_LISTED_EXTRAS
    ? `${labelFor(base)}, plus ${extras.length} more areas`
    : `${labelFor(base)}, plus ${listNames(extras)}`;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What the key's preset grants today that the key doesn't, with new areas and raised levels told
 * apart: "Operator now adds Prompts, and raises Sessions to Manage."
 */
export function driftSummary(
  catalogue: ApiKeyCapabilityCatalogue,
  presetLabel: string,
  drift: ApiKeyCapabilityDifference[]
): string {
  if (drift.some((difference) => difference.loses)) {
    return `${presetLabel} now grants ${drift
      .map(
        (difference) =>
          `${capabilityName(catalogue, difference.capabilityId)}: ${levelLabel(
            catalogue,
            difference.capabilityId,
            difference.to
          )} (was ${levelLabel(catalogue, difference.capabilityId, difference.from)})`
      )
      .join(", ")}.`;
  }
  const isNew = (difference: ApiKeyCapabilityDifference) => difference.from === NO_ACCESS_LEVEL_ID;
  const added = drift.filter(isNew);
  const raised = drift.filter((difference) => !isNew(difference));
  const parts = [
    added.length > 0
      ? `adds ${listNames(added.map((d) => capabilityName(catalogue, d.capabilityId)))}`
      : undefined,
    raised.length > 0
      ? `raises ${listNames(
          raised.map(
            (d) =>
              `${capabilityName(catalogue, d.capabilityId)} to ${levelLabel(catalogue, d.capabilityId, d.to)}`
          )
        )}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return `${presetLabel} now ${parts.join(", and ")}.`;
}

export function customKeyUsesSelectedTasks(
  catalogue: ApiKeyCapabilityCatalogue,
  capabilities: ApiKeyCapabilityMap,
  taskScope: TaskScope
): boolean {
  return taskScope === "selected" && grantsTaskAccess(catalogue, capabilities, false);
}

function scopeKey(scope: string): string {
  const [action, resource] = scope.split(":");
  return resource ? `${action}:${resource}` : scope;
}

export function scopesLostOnSave(
  catalogue: ApiKeyCapabilityCatalogue,
  unmatchedScopes: string[],
  nextCapabilities: ApiKeyCapabilityMap,
  nextTasks: string[]
): string[] {
  const granted = new Set(
    catalogue.capabilities.flatMap((capability) => {
      const scopes =
        capability.levels.find((level) => level.id === nextCapabilities[capability.id])?.scopes ??
        [];
      return capability.taskSelection?.kind === "scoped"
        ? scopes.flatMap((scope) => restrictScopeToTasks(scope, nextTasks))
        : scopes;
    })
  );
  return unmatchedScopes.filter((scope) => !granted.has(scope) && !granted.has(scopeKey(scope)));
}

export function customCapabilitiesAfterChange(
  catalogue: ApiKeyCapabilityCatalogue,
  next: ApiKeyCapabilityMap,
  taskScope: TaskScope
): ApiKeyCapabilityMap {
  const required = applyApiKeyCapabilityRequirements(catalogue.capabilities, next).capabilities;
  const allowed = customKeyUsesSelectedTasks(catalogue, required, taskScope)
    ? withoutTaskSelectionUnavailable(catalogue.capabilities, required)
    : required;
  return applyApiKeyCapabilityRequirements(catalogue.capabilities, allowed).capabilities;
}

export type TaskAccess = { taskScope: TaskScope; selectedTasks: string[] };

export function taskAccessAfterPreset(
  preset: { limitsTasks?: boolean },
  current: TaskAccess,
  how: "replace" | "add"
): TaskAccess {
  if (!preset.limitsTasks) return current;
  if (how === "add" && current.taskScope === "selected") return current;
  return { taskScope: "selected", selectedTasks: [] };
}

export function levelLabel(
  catalogue: ApiKeyCapabilityCatalogue,
  capabilityId: string,
  levelId: string
) {
  const capability = catalogue.capabilities.find((candidate) => candidate.id === capabilityId);
  return capability?.levels.find((level) => level.id === levelId)?.label ?? levelId;
}

export function capabilityName(catalogue: ApiKeyCapabilityCatalogue, capabilityId: string) {
  return (
    catalogue.capabilities.find((candidate) => candidate.id === capabilityId)?.label ?? capabilityId
  );
}

function sameTasks(a: string[], b: string[]) {
  return a.length === b.length && a.every((task) => b.includes(task));
}

export type KeyTaskAccess = { grantsTasks: boolean; tasks: string[] };

export function grantsTaskAccess(
  catalogue: ApiKeyCapabilityCatalogue,
  capabilities: ApiKeyCapabilityMap,
  fullAccess: boolean
): boolean {
  return (
    fullAccess ||
    catalogue.capabilities.some(
      (capability) =>
        capability.taskSelection?.kind === "scoped" && isGranted(capabilities, capability.id)
    )
  );
}

export function taskSelectionChange(from: KeyTaskAccess, to: KeyTaskAccess): string | undefined {
  if (!to.grantsTasks) return undefined;
  if (!from.grantsTasks && to.tasks.length === 0) return undefined;
  if (from.grantsTasks && sameTasks(from.tasks, to.tasks)) return undefined;
  const was = !from.grantsTasks
    ? "no task access"
    : from.tasks.length === 0
      ? "all tasks"
      : from.tasks.join(", ");
  const now = to.tasks.length === 0 ? "all tasks" : `limited to ${to.tasks.join(", ")}`;
  return `Tasks: ${now} (was ${was})`;
}

export function driftLine(
  catalogue: ApiKeyCapabilityCatalogue,
  difference: ApiKeyCapabilityDifference
) {
  const from = levelLabel(catalogue, difference.capabilityId, difference.from);
  const to = levelLabel(catalogue, difference.capabilityId, difference.to);
  const name = capabilityName(catalogue, difference.capabilityId);
  return `${name}: ${from}, preset now grants ${to}`;
}

/**
 * One sentence naming the level that locks an area, e.g. "Input streams: Read and write needs
 * Runs: Read and write." When several levels would do, it names the smallest and adds "or more".
 */
export function requirementReason(
  catalogue: ApiKeyCapability[],
  capabilities: ApiKeyCapabilityMap,
  requiredById: string,
  target: ApiKeyCapability
): string {
  const requiredBy = catalogue.find((capability) => capability.id === requiredById);
  const level = requiredBy?.levels.find((l) => l.id === capabilities[requiredById]);
  const levelIds =
    level?.requires?.find((requirement) => requirement.capabilityId === target.id)?.levelIds ?? [];
  const acceptable = target.levels.filter((l) => levelIds.includes(l.id));
  const cause = requiredBy && level ? `${requiredBy.label}: ${level.label}` : requiredById;
  const needed = acceptable[0]
    ? `${target.label}: ${acceptable[0].label}${acceptable.length > 1 ? " or more" : ""}`
    : target.label;
  return `${cause} needs ${needed}.`;
}
