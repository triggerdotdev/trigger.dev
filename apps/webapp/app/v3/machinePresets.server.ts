import { MachineConfig, MachinePreset, MachinePresetName } from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

export const presets = {
  micro: {
    cpu: 0.25,
    memory: 0.25,
    centsPerMs: env.CENTS_PER_HOUR_MICRO / 3_600_000,
  },
  "small-1x": {
    cpu: 0.5,
    memory: 0.5,
    centsPerMs: env.CENTS_PER_HOUR_SMALL_1X / 3_600_000,
  },
  "small-2x": {
    cpu: 1,
    memory: 1,
    centsPerMs: env.CENTS_PER_HOUR_SMALL_2X / 3_600_000,
  },
  "medium-1x": {
    cpu: 1,
    memory: 2,
    centsPerMs: env.CENTS_PER_HOUR_MEDIUM_1X / 3_600_000,
  },
  "medium-2x": {
    cpu: 2,
    memory: 4,
    centsPerMs: env.CENTS_PER_HOUR_MEDIUM_2X / 3_600_000,
  },
  "large-1x": {
    cpu: 4,
    memory: 8,
    centsPerMs: env.CENTS_PER_HOUR_LARGE_1X / 3_600_000,
  },
  "large-2x": {
    cpu: 8,
    memory: 16,
    centsPerMs: env.CENTS_PER_HOUR_LARGE_2X / 3_600_000,
  },
};

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

export function machinePresetFromName(name: MachinePresetName): MachinePreset {
  return {
    name,
    ...presets[name],
  };
}

// Finds the smallest machine preset name that satisfies the given CPU and memory requirements
function derivePresetNameFromValues(cpu: number, memory: number): MachinePresetName {
  for (const [name, preset] of Object.entries(presets)) {
    if (preset.cpu >= cpu && preset.memory >= memory) {
      return name as MachinePresetName;
    }
  }

  return "small-1x";
}
