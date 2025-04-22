import { MachinePresetResources } from "../schemas/common.js";

/**
 * Returns a value to be used for `--max-old-space-size`. It is in MiB.
 * Setting this correctly means V8 spends more times running Garbage Collection (GC).
 * It won't eliminate crashes but it will help avoid them.
 * @param {MachinePresetResources} machine - The machine preset configuration containing memory specifications
 * @param {number} [overhead=0.2] - The memory overhead factor (0.2 = 20% reserved for system operations)
 * @returns {number} The calculated max old space size in MiB
 */
export function maxOldSpaceSizeForMachine(
  machine: MachinePresetResources,
  overhead: number = 0.2
): number {
  return Math.round(machine.memory * 1_024 * (1 - overhead));
}

/**
 * Returns a flag to be used for `--max-old-space-size`. It is in MiB.
 * Setting this correctly means V8 spends more times running Garbage Collection (GC).
 * It won't eliminate crashes but it will help avoid them.
 * @param {MachinePresetResources} machine - The machine preset configuration containing memory specifications
 * @param {number} [overhead=0.2] - The memory overhead factor (0.2 = 20% reserved for system operations)
 * @returns {string} The calculated max old space size flag
 */
export function maxOldSpaceSizeFlag(
  machine: MachinePresetResources,
  overhead: number = 0.2
): string {
  return `--max-old-space-size=${maxOldSpaceSizeForMachine(machine, overhead)}`;
}

/**
 * Takes the existing NODE_OPTIONS value, removes any existing max-old-space-size flag, and adds a new one.
 * @param {string | undefined} existingOptions - The existing NODE_OPTIONS value
 * @param {MachinePresetResources} machine - The machine preset configuration containing memory specifications
 * @param {number} [overhead=0.2] - The memory overhead factor (0.2 = 20% reserved for system operations)
 * @returns {string} The updated NODE_OPTIONS value with the new max-old-space-size flag
 */
export function nodeOptionsWithMaxOldSpaceSize(
  existingOptions: string | undefined,
  machine: MachinePresetResources,
  overhead: number = 0.2
): string {
  let options = existingOptions ?? "";

  //remove existing max-old-space-size flag
  options = options.replace(/--max-old-space-size=\d+/g, "").trim();

  //get max-old-space-size flag
  const flag = maxOldSpaceSizeFlag(machine, overhead);

  return normalizeCommandLineFlags(options ? `${options} ${flag}` : flag);
}

/**
 * Normalizes spaces in a string of command line flags, ensuring single spaces between flags
 * @param {string} input - The string to normalize
 * @returns {string} The normalized string with single spaces between flags
 */
function normalizeCommandLineFlags(input: string): string {
  return input.split(/\s+/).filter(Boolean).join(" ");
}
