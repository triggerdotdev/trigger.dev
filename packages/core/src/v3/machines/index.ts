import { MachinePreset } from "../schemas/common.js";

/**
 * Returns a value to be used for `--max-old-space-size`. It is in MiB.
 * Setting this correctly means V8 spends more times running Garbage Collection (GC).
 * It won't eliminate crashes but it will help avoid them.
 * @param {MachinePreset} machine - The machine preset configuration containing memory specifications
 * @param {number} [overhead=0.2] - The memory overhead factor (0.2 = 20% reserved for system operations)
 * @returns {number} The calculated max old space size in MiB
 */
export function maxOldSpaceSizeForMachine(machine: MachinePreset, overhead = 0.2) {
  return machine.memory * 1_024 * (1 - overhead);
}
