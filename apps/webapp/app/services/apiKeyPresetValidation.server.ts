import {
  type ApiKeyPreset,
  CUSTOM_API_KEY_PRESET_ID,
  DELETED_API_KEY_PRESET_MESSAGE,
  isSavedApiKeyPresetId,
  RESTRICTED_API_KEYS_PLAN_MESSAGE,
} from "@trigger.dev/plugins";
import { FULL_ACCESS_PRESET_ID, type RbacAbility } from "@trigger.dev/rbac";

type ApiKeyAccessInput = {
  presets: Pick<ApiKeyPreset, "id" | "available" | "usesTaskSelection">[] | null;
  presetId?: string;
  capabilities?: Record<string, string>;
  taskScope?: "all" | "selected";
  taskIdentifiers: string[];
  hasTaskParameters: boolean;
};

export const API_KEY_PRESET_PERMISSION_MESSAGE =
  "Only admins and owners can save or delete presets. Ask one of them to do it for you.";

export function canManageApiKeyPresets(ability: Pick<RbacAbility, "can">): boolean {
  return ability.can("write", { type: "apiKeys", envType: "PRODUCTION" });
}

export type ApiKeyAccess = {
  presetId: string;
  capabilities?: Record<string, string>;
  taskIdentifiers?: string[];
};

export function validateApiKeyAccess(input: ApiKeyAccessInput): ApiKeyAccess {
  const { presetId, usesTaskSelection } = validatePreset(input);
  return {
    presetId,
    capabilities: presetId === CUSTOM_API_KEY_PRESET_ID ? input.capabilities : undefined,
    taskIdentifiers:
      usesTaskSelection && input.taskScope === "selected" ? input.taskIdentifiers : undefined,
  };
}

function validatePreset({
  presets,
  presetId,
  taskScope,
  taskIdentifiers,
  hasTaskParameters,
}: ApiKeyAccessInput): { presetId: string; usesTaskSelection: boolean } {
  const fullAccess = { presetId: FULL_ACCESS_PRESET_ID, usesTaskSelection: false };

  if (presets === null) {
    if (presetId !== FULL_ACCESS_PRESET_ID || hasTaskParameters) {
      throw new Error("API key access presets are not available");
    }
    return fullAccess;
  }

  if (!presetId) {
    throw new Error("A preset is required");
  }

  if (presetId === CUSTOM_API_KEY_PRESET_ID) {
    validateTaskScope(taskScope, taskIdentifiers);
    return { presetId, usesTaskSelection: true };
  }

  const preset = presets.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new Error(
      isSavedApiKeyPresetId(presetId)
        ? DELETED_API_KEY_PRESET_MESSAGE
        : "Invalid API key access preset"
    );
  }
  if (!preset.available) {
    throw new Error(RESTRICTED_API_KEYS_PLAN_MESSAGE);
  }

  if (!preset.usesTaskSelection && hasTaskParameters) {
    throw new Error("This API key access preset does not support task selection");
  }
  if (preset.usesTaskSelection) {
    validateTaskScope(taskScope, taskIdentifiers);
  }

  return { presetId: preset.id, usesTaskSelection: preset.usesTaskSelection ?? false };
}

function validateTaskScope(taskScope: "all" | "selected" | undefined, taskIdentifiers: string[]) {
  if (taskScope === "selected" && taskIdentifiers.length === 0) {
    throw new Error("Select at least one task");
  }
  if (taskScope !== "selected" && taskIdentifiers.length > 0) {
    throw new Error("Task identifiers require selected task scope");
  }
}
