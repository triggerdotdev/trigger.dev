import { MachineConfig, MachinePreset, MachinePresetName } from "@trigger.dev/core/v3";
import { Logger } from "@trigger.dev/core/logger";

const logger = new Logger("machinePresetFromConfig");

export function machinePresetFromConfig({
  defaultMachine,
  machines,
  config,
}: {
  defaultMachine: MachinePresetName;
  machines: Record<string, MachinePreset>;
  config: unknown;
}): MachinePreset {
  const parsedConfig = MachineConfig.safeParse(config);

  if (!parsedConfig.success) {
    logger.error("Failed to parse machine config", { config });

    return machinePresetFromName(machines, "small-1x");
  }

  if (parsedConfig.data.preset) {
    return machinePresetFromName(machines, parsedConfig.data.preset);
  }

  if (parsedConfig.data.cpu && parsedConfig.data.memory) {
    const name = derivePresetNameFromValues(
      machines,
      parsedConfig.data.cpu,
      parsedConfig.data.memory
    );
    if (!name) {
      return machinePresetFromName(machines, defaultMachine);
    }

    return machinePresetFromName(machines, name);
  }

  return machinePresetFromName(machines, "small-1x");
}

export function machinePresetFromName(
  machines: Record<string, MachinePreset>,
  name: MachinePresetName
): MachinePreset {
  return {
    ...machines[name],
  };
}

// Finds the smallest machine preset name that satisfies the given CPU and memory requirements
function derivePresetNameFromValues(
  machines: Record<string, MachinePreset>,
  cpu: number,
  memory: number
): MachinePresetName | undefined {
  for (const [name, preset] of Object.entries(machines)) {
    if (preset.cpu >= cpu && preset.memory >= memory) {
      return name as MachinePresetName;
    }
  }
}
