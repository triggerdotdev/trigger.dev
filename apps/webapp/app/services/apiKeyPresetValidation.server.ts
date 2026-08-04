import { FULL_ACCESS_PRESET_ID } from "@trigger.dev/rbac";

export type ApiKeyPreset = {
  id: string;
  available: boolean;
  label: string;
  description: string;
  usesTaskSelection?: boolean;
};

export function validateCreateApiKeyPreset({
  presets,
  presetId,
  taskScope,
  taskIdentifiers,
  hasTaskParameters,
}: {
  presets: ApiKeyPreset[] | null;
  presetId?: string;
  taskScope?: "all" | "selected";
  taskIdentifiers: string[];
  hasTaskParameters: boolean;
}): { presetId: string; usesTaskSelection: boolean } {
  const fullAccess = { presetId: FULL_ACCESS_PRESET_ID, usesTaskSelection: false };

  if (presets === null) {
    if (presetId !== undefined || hasTaskParameters) {
      throw new Error("API key access presets are not available");
    }
    return fullAccess;
  }

  if (!presetId) {
    if (hasTaskParameters) {
      throw new Error("A preset is required when selecting tasks");
    }
    return fullAccess;
  }

  const preset = presets.find((candidate) => candidate.id === presetId);
  if (!preset) {
    throw new Error("Invalid API key access preset");
  }
  if (!preset.available) {
    throw new Error("This API key access preset is not available on your plan");
  }

  if (!preset.usesTaskSelection && hasTaskParameters) {
    throw new Error("This API key access preset does not support task selection");
  }
  if (preset.usesTaskSelection && taskScope === "selected" && taskIdentifiers.length === 0) {
    throw new Error("Select at least one task");
  }
  if (preset.usesTaskSelection && taskScope !== "selected" && taskIdentifiers.length > 0) {
    throw new Error("Task identifiers require selected task scope");
  }

  return { presetId: preset.id, usesTaskSelection: preset.usesTaskSelection ?? false };
}
