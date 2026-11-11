export const CUSTOM_API_KEY_PRESET_ID = "CUSTOM";

export const RESTRICTED_API_KEYS_PLAN_MESSAGE =
  "Restricted API keys need the Pro plan or above. Upgrade to create them.";

export const DELETED_API_KEY_PRESET_MESSAGE = "This saved preset was deleted. Pick another preset.";

export function isSavedApiKeyPresetId(presetId: string): boolean {
  return presetId.startsWith("apikeypreset_");
}

export const NO_ACCESS_LEVEL_ID = "none";

export type ApiKeyCapabilityRequirement = {
  capabilityId: string;
  levelIds: string[];
  note: string;
};

export type ApiKeyCapabilityLevel = {
  id: string;
  label: string;
  scopes: string[];
  requires?: ApiKeyCapabilityRequirement[];
};

type ApiKeyCapabilityTaskSelection = { kind: "scoped" } | { kind: "unavailable"; reason: string };

export type ApiKeyCapability = {
  id: string;
  label: string;
  hint?: string;
  levels: ApiKeyCapabilityLevel[];
  taskSelection?: ApiKeyCapabilityTaskSelection;
};

export type ApiKeyCapabilityMap = Record<string, string>;

export type ApiKeyCapabilityCatalogue = {
  available: boolean;
  capabilities: ApiKeyCapability[];
};

type AppliedApiKeyCapabilityRequirement = {
  capabilityId: string;
  requiredBy: string;
  note: string;
};

function levelOf(capability: ApiKeyCapability, levelId: string | undefined) {
  return capability.levels.find((level) => level.id === (levelId ?? NO_ACCESS_LEVEL_ID));
}

function smallestLevelCovering(
  capability: ApiKeyCapability,
  scopes: Set<string>,
  candidates: ApiKeyCapabilityLevel[] = capability.levels
): ApiKeyCapabilityLevel | undefined {
  return candidates
    .filter((level) => [...scopes].every((scope) => level.scopes.includes(scope)))
    .sort((a, b) => a.scopes.length - b.scopes.length)[0];
}

function compact(map: ApiKeyCapabilityMap): ApiKeyCapabilityMap {
  return Object.fromEntries(
    Object.entries(map).filter(([, levelId]) => levelId !== NO_ACCESS_LEVEL_ID)
  );
}

export function mergeApiKeyCapabilities(
  catalogue: ApiKeyCapability[],
  a: ApiKeyCapabilityMap,
  b: ApiKeyCapabilityMap
): ApiKeyCapabilityMap {
  const merged: ApiKeyCapabilityMap = {};
  for (const capability of catalogue) {
    const scopes = new Set([
      ...(levelOf(capability, a[capability.id])?.scopes ?? []),
      ...(levelOf(capability, b[capability.id])?.scopes ?? []),
    ]);
    const level =
      smallestLevelCovering(capability, scopes) ?? capability.levels[capability.levels.length - 1];
    if (level) merged[capability.id] = level.id;
  }
  return compact(merged);
}

export function applyApiKeyCapabilityRequirements(
  catalogue: ApiKeyCapability[],
  map: ApiKeyCapabilityMap
): { capabilities: ApiKeyCapabilityMap; requirements: AppliedApiKeyCapabilityRequirement[] } {
  const capabilities = { ...map };
  const requirements: AppliedApiKeyCapabilityRequirement[] = [];

  for (let pass = 0; pass <= catalogue.length; pass++) {
    let changed = false;
    requirements.length = 0;

    for (const capability of catalogue) {
      const level = levelOf(capability, capabilities[capability.id]);
      for (const requirement of level?.requires ?? []) {
        const target = catalogue.find((candidate) => candidate.id === requirement.capabilityId);
        if (!target) continue;
        requirements.push({
          capabilityId: target.id,
          requiredBy: capability.id,
          note: requirement.note,
        });

        const current = capabilities[target.id] ?? NO_ACCESS_LEVEL_ID;
        if (requirement.levelIds.includes(current)) continue;

        const acceptable = target.levels.filter((candidate) =>
          requirement.levelIds.includes(candidate.id)
        );
        const next =
          smallestLevelCovering(
            target,
            new Set(levelOf(target, current)?.scopes ?? []),
            acceptable
          ) ?? acceptable[acceptable.length - 1];
        if (next) {
          capabilities[target.id] = next.id;
          changed = true;
        }
      }
    }

    if (!changed) break;
  }

  return { capabilities: compact(capabilities), requirements };
}

const TASK_RESOURCE = "tasks";

export function restrictScopeToTasks(scope: string, taskIdentifiers: readonly string[]): string[] {
  const [action, resource, ...rest] = scope.split(":");
  if (resource !== TASK_RESOURCE || rest.length > 0 || taskIdentifiers.length === 0) {
    return [scope];
  }
  return taskIdentifiers.map((taskIdentifier) => `${action}:${resource}:${taskIdentifier}`);
}

export function withoutTaskSelectionUnavailable(
  catalogue: ApiKeyCapability[],
  map: ApiKeyCapabilityMap
): ApiKeyCapabilityMap {
  const unavailable = new Set(
    catalogue
      .filter((capability) => capability.taskSelection?.kind === "unavailable")
      .map((capability) => capability.id)
  );
  return Object.fromEntries(Object.entries(map).filter(([id]) => !unavailable.has(id)));
}

export function apiKeyCapabilitiesEqual(a: ApiKeyCapabilityMap, b: ApiKeyCapabilityMap): boolean {
  const left = compact(a);
  const right = compact(b);
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
}

export type ApiKeyCapabilityDifference = {
  capabilityId: string;
  from: string;
  to: string;
  gains: boolean;
  loses: boolean;
};

export function apiKeyCapabilityDifferences(
  catalogue: ApiKeyCapability[],
  from: ApiKeyCapabilityMap,
  to: ApiKeyCapabilityMap
): ApiKeyCapabilityDifference[] {
  return catalogue.flatMap((capability) => {
    const fromLevel = levelOf(capability, from[capability.id]);
    const toLevel = levelOf(capability, to[capability.id]);
    if (!fromLevel || !toLevel || fromLevel.id === toLevel.id) return [];
    return [
      {
        capabilityId: capability.id,
        from: fromLevel.id,
        to: toLevel.id,
        gains: toLevel.scopes.some((scope) => !fromLevel.scopes.includes(scope)),
        loses: fromLevel.scopes.some((scope) => !toLevel.scopes.includes(scope)),
      },
    ];
  });
}

export function apiKeyCapabilitiesForKey(
  catalogue: ApiKeyCapability[],
  presetCapabilities: ApiKeyCapabilityMap,
  taskIdentifiers: readonly string[] = []
): ApiKeyCapabilityMap {
  const { capabilities } = applyApiKeyCapabilityRequirements(catalogue, presetCapabilities);
  return taskIdentifiers.length > 0
    ? withoutTaskSelectionUnavailable(catalogue, capabilities)
    : capabilities;
}
