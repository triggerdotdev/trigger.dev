import {
  type ApiKeyCapabilityCatalogue,
  type ApiKeyCapabilityMap,
  apiKeyCapabilitiesForKey,
  CUSTOM_API_KEY_PRESET_ID,
} from "@trigger.dev/plugins";
import { useState } from "react";
import { MAX_API_KEY_TASK_IDENTIFIERS } from "~/consts";
import {
  type ApiKeyAccessPreset,
  customKeyUsesSelectedTasks,
  type InitialApiKeyAccess,
  type TaskScope,
} from "~/utils/apiKeyAccess";

export function defaultApiKeyPresetId(presets: ApiKeyAccessPreset[] | null): string {
  return (
    presets?.find((preset) => preset.id === "FULL_ACCESS" && preset.available)?.id ??
    presets?.find((preset) => preset.available)?.id ??
    "FULL_ACCESS"
  );
}

export type ApiKeyAccessState = ReturnType<typeof useApiKeyAccess>;

export function useApiKeyAccess({
  presets,
  catalogue,
  isRbacPluginAvailable,
  initial,
}: {
  presets: ApiKeyAccessPreset[] | null;
  catalogue: ApiKeyCapabilityCatalogue | null;
  isRbacPluginAvailable: boolean;
  initial?: InitialApiKeyAccess;
}) {
  const defaultPresetId = defaultApiKeyPresetId(presets);
  const [start] = useState<InitialApiKeyAccess>(
    () =>
      initial ?? {
        mode: "preset",
        presetId: defaultPresetId,
        capabilities: {},
        taskScope: "all",
        tasks: [],
      }
  );
  const [chosenPresetId, setPresetId] = useState(start.presetId);
  const presetId = presets?.some((preset) => preset.id === chosenPresetId)
    ? chosenPresetId
    : defaultPresetId;
  const [accessMode, setAccessMode] = useState<"preset" | "custom">(start.mode);
  const [customCapabilities, setCustomCapabilities] = useState<ApiKeyCapabilityMap>(
    start.capabilities
  );
  const [taskScope, setTaskScope] = useState<TaskScope>(start.taskScope);
  const [selectedTasks, setSelectedTasks] = useState<string[]>(start.tasks);

  function reset() {
    setPresetId(defaultPresetId);
    setAccessMode("preset");
    setCustomCapabilities({});
    setTaskScope("all");
    setSelectedTasks([]);
  }

  const selectedPreset = presets?.find((preset) => preset.id === presetId);
  const showAccessControls = isRbacPluginAvailable && presets !== null;
  const isCustom = showAccessControls && catalogue !== null && accessMode === "custom";
  const hasCustomCapabilities = Object.keys(customCapabilities).length > 0;
  const selectedPresetIsAvailable = isCustom
    ? catalogue?.available === true
    : !showAccessControls || selectedPreset?.available === true;
  const customGrantsTasks =
    isCustom &&
    catalogue !== null &&
    customKeyUsesSelectedTasks(catalogue, customCapabilities, "selected");
  const usesSelectedTasks =
    isCustom &&
    catalogue !== null &&
    customKeyUsesSelectedTasks(catalogue, customCapabilities, taskScope);
  const usesTaskSelection = isCustom
    ? customGrantsTasks
    : showAccessControls && (selectedPreset?.usesTaskSelection ?? false);

  function switchToCustom() {
    setCustomCapabilities(selectedPreset?.capabilities ?? {});
    if (!selectedPreset?.usesTaskSelection) {
      setTaskScope("all");
      setSelectedTasks([]);
    }
    setAccessMode("custom");
  }

  const needsSelectedTask = usesTaskSelection && taskScope === "selected";
  const nextTasks = needsSelectedTask ? selectedTasks : [];
  const nextFullAccess = !isCustom && (selectedPreset?.fullAccess ?? false);
  const nextCapabilities = catalogue
    ? apiKeyCapabilitiesForKey(
        catalogue.capabilities,
        isCustom ? customCapabilities : (selectedPreset?.capabilities ?? {}),
        nextTasks
      )
    : {};
  const nextPresetId = isCustom ? CUSTOM_API_KEY_PRESET_ID : presetId;
  const canSubmitAccess =
    selectedPresetIsAvailable &&
    !(isCustom && !hasCustomCapabilities) &&
    !(
      needsSelectedTask &&
      (selectedTasks.length === 0 || selectedTasks.length > MAX_API_KEY_TASK_IDENTIFIERS)
    );

  return {
    presets,
    catalogue,
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
    reset,
    switchToCustom,
    selectedPreset,
    showAccessControls,
    isCustom,
    hasCustomCapabilities,
    selectedPresetIsAvailable,
    usesSelectedTasks,
    usesTaskSelection,
    needsSelectedTask,
    nextTasks,
    nextFullAccess,
    nextCapabilities,
    nextPresetId,
    canSubmitAccess,
  };
}
