export function detectBadJsonStrings(jsonString: string): boolean {
  // Single regex with global flag to find all matches with their positions
  const regex = /\\ud[89ab][0-9a-f]{2}|\\ud[cd][0-9a-f]{2}/g;
  const matches: Array<{ index: number; isHigh: boolean }> = [];

  let match;
  while ((match = regex.exec(jsonString)) !== null) {
    const isHigh =
      match[0].startsWith("\\ud8") ||
      match[0].startsWith("\\ud9") ||
      match[0].startsWith("\\uda") ||
      match[0].startsWith("\\udb");
    matches.push({ index: match.index, isHigh });
  }

  if (matches.length === 0) {
    return false; // No Unicode escapes found
  }

  // Check for incomplete pairs
  const highSurrogates = new Set<number>();
  const lowSurrogates = new Set<number>();

  for (const { index, isHigh } of matches) {
    if (isHigh) {
      highSurrogates.add(index);
    } else {
      lowSurrogates.add(index);
    }
  }

  // Check for unmatched surrogates
  for (const highIndex of highSurrogates) {
    const expectedLowIndex = highIndex + 6; // Length of high surrogate
    if (!lowSurrogates.has(expectedLowIndex)) {
      return true; // Incomplete high surrogate
    }
  }

  for (const lowIndex of lowSurrogates) {
    const expectedHighIndex = lowIndex - 6; // Length of low surrogate
    if (!highSurrogates.has(expectedHighIndex)) {
      return true; // Incomplete low surrogate
    }
  }

  return false;
}
