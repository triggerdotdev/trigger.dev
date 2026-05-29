/**
 * Parses a version string into comparable numeric parts.
 * Handles formats like "1.2.3", "20240115.1", "v1.0.0", plain timestamps, etc.
 * Non-numeric pre-release suffixes (e.g. "-beta.1") are stripped for ordering purposes.
 */
function parseVersionParts(version: string): number[] {
  const cleaned = version.replace(/^v/i, "").replace(/[-+].*$/, "");
  return cleaned.split(".").map((p) => {
    const n = parseInt(p, 10);
    return isNaN(n) ? 0 : n;
  });
}

/**
 * Compares two version strings using numeric segment comparison (descending).
 * Falls back to lexicographic comparison when segments are equal.
 * Returns a negative number if `a` should come before `b` (i.e. `a` is newer).
 */
export function compareVersionsDescending(a: string, b: string): number {
  const partsA = parseVersionParts(a);
  const partsB = parseVersionParts(b);
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const segA = partsA[i] ?? 0;
    const segB = partsB[i] ?? 0;
    if (segA !== segB) {
      return segB - segA;
    }
  }

  return b.localeCompare(a);
}

/**
 * Sorts an array of version strings in descending order (newest first).
 * Non-destructive – returns a new array.
 */
export function sortVersionsDescending(versions: string[]): string[] {
  return [...versions].sort(compareVersionsDescending);
}
