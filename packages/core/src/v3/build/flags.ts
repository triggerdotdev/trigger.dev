/**
 * Deduplicates command line flags by keeping only the last occurrence of each flag.
 * Preserves the order of the last occurrence of each flag.
 *
 * @param flags - A space-separated string of command line flags
 * @returns A space-separated string of deduplicated flags
 *
 * @example
 * // Single flags are preserved
 * dedupFlags("--quiet --verbose") // returns "--quiet --verbose"
 *
 * @example
 * // For duplicate flags, the last value wins and maintains its position
 * dedupFlags("--debug=false --log=info --debug=true") // returns "--log=info --debug=true"
 *
 * @example
 * // Mixing flags with and without values
 * dedupFlags("-v --log=debug -v") // returns "--log=debug -v"
 */
export function dedupFlags(flags: string): string {
  const seen = new Set<string>();
  const result: [string, string | boolean][] = [];

  const pairs = flags
    .split(" ")
    .filter(Boolean) // Remove empty strings from multiple spaces
    .map((flag): [string, string | boolean] => {
      const equalIndex = flag.indexOf("=");
      if (equalIndex !== -1) {
        const key = flag.slice(0, equalIndex).replace(/_/g, "-");
        const value = flag.slice(equalIndex + 1);
        return [key, value];
      } else {
        return [flag.replace(/_/g, "-"), true];
      }
    });

  // Process in reverse to keep last occurrence
  for (const [key, value] of pairs.reverse()) {
    if (!seen.has(key)) {
      seen.add(key);
      result.unshift([key, value]);
    }
  }

  return result.map(([key, value]) => (value === true ? key : `${key}=${value}`)).join(" ");
}
