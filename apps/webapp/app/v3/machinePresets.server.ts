import { machineDefinition } from "@trigger.dev/platform/v3";
import { MachineConfig, MachinePreset, MachinePresetName } from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";

const presets = {
  micro: machineDefinition({
    code: "micro",
    title: "Micro",
    cpu: 0.25,
    memory: 0.25,
    centsPerVCpuSecond: env.CENTS_PER_VCPU_SECOND,
    centsPerGbRamSecond: env.CENTS_PER_GB_RAM_SECOND,
  }),
  "small-1x": machineDefinition({
    code: "small-1x",
    title: "Small 1x",
    cpu: 0.5,
    memory: 0.5,
    centsPerVCpuSecond: env.CENTS_PER_VCPU_SECOND,
    centsPerGbRamSecond: env.CENTS_PER_GB_RAM_SECOND,
  }),
  "small-2x": machineDefinition({
    code: "small-2x",
    title: "Small 2x",
    cpu: 1,
    memory: 1,
    centsPerVCpuSecond: env.CENTS_PER_VCPU_SECOND,
    centsPerGbRamSecond: env.CENTS_PER_GB_RAM_SECOND,
  }),
  "medium-1x": machineDefinition({
    code: "medium-1x",
    title: "Medium 1x",
    cpu: 1,
    memory: 2,
    centsPerVCpuSecond: env.CENTS_PER_VCPU_SECOND,
    centsPerGbRamSecond: env.CENTS_PER_GB_RAM_SECOND,
  }),
  "medium-2x": machineDefinition({
    code: "medium-2x",
    title: "Medium 2x",
    cpu: 2,
    memory: 4,
    centsPerVCpuSecond: env.CENTS_PER_VCPU_SECOND,
    centsPerGbRamSecond: env.CENTS_PER_GB_RAM_SECOND,
  }),
  "large-1x": machineDefinition({
    code: "large-1x",
    title: "Large 1x",
    cpu: 4,
    memory: 8,
    centsPerVCpuSecond: env.CENTS_PER_VCPU_SECOND,
    centsPerGbRamSecond: env.CENTS_PER_GB_RAM_SECOND,
  }),
  "large-2x": machineDefinition({
    code: "large-2x",
    title: "Large 2x",
    cpu: 8,
    memory: 16,
    centsPerVCpuSecond: env.CENTS_PER_VCPU_SECOND,
    centsPerGbRamSecond: env.CENTS_PER_GB_RAM_SECOND,
  }),
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

function machinePresetFromName(name: MachinePresetName): MachinePreset {
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
