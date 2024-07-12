import { MachineConfig , type MachinePreset , type MachinePresetName } from '@trigger.dev/core/v3/schemas';
import { defaultMachine, machines } from "@trigger.dev/platform/v3";
import { logger } from "~/services/logger.server";

export function machinePresetFromConfig(config: unknown): MachinePreset {
  const parsedConfig = MachineConfig.safeParse(config);

  if (!parsedConfig.success) {
    logger.error("Failed to parse machine config", { config });

    return machinePresetFromName("small-1x");
  }

  if (parsedConfig.data.preset) {
    return machinePresetFromName(parsedConfig.data.preset);
  }

  if (parsedConfig.data.cpu && parsedConfig.data.memory) {
    const name = derivePresetNameFromValues(parsedConfig.data.cpu, parsedConfig.data.memory);

    return machinePresetFromName(name);
  }

  return machinePresetFromName("small-1x");
}

function machinePresetFromName(name: MachinePresetName): MachinePreset {
  return {
    name,
    ...machines[name],
  };
}

// Finds the smallest machine preset name that satisfies the given CPU and memory requirements
function derivePresetNameFromValues(cpu: number, memory: number): MachinePresetName {
  for (const [name, preset] of Object.entries(machines)) {
    if (preset.cpu >= cpu && preset.memory >= memory) {
      return name as MachinePresetName;
    }
  }

  return defaultMachine;
}
