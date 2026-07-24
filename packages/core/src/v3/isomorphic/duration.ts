/**
 * Parses a natural language duration string into milliseconds.
 *
 * @param duration - Duration string like "1s", "5m", "2h", "1d", "1w"
 * @returns The duration in milliseconds, or undefined if invalid
 *
 * @example
 * parseNaturalLanguageDurationInMs("30m") // 1800000
 * parseNaturalLanguageDurationInMs("2h") // 7200000
 */
const DURATION_UNIT_TO_MS: Record<string, number> = {
  w: 7 * 24 * 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  h: 60 * 60 * 1000,
  m: 60 * 1000,
  s: 1000,
};

export function parseNaturalLanguageDurationInMs(duration: string): number | undefined {
  // Handle Code scanning alert #44 by limiting the length of the input string
  if (duration.length > 100) {
    return undefined;
  }

  // The whole string must be a run of "<number><unit>" tokens, in any order.
  const validPattern = /^(\d+(?:w|d|hr|h|m|s))+$/;
  if (!validPattern.test(duration)) {
    return undefined;
  }

  // Sum every token. Reading each unit with a single `.match()` (as this used
  // to) only picked up the first occurrence, so a repeated unit that the
  // pattern above accepts - e.g. "1h2h" - silently dropped all but the first.
  // `hr` is tried before `h` so "1hr" is one hour, not "1h" plus a stray "r".
  let totalMilliseconds = 0;
  let hasMatch = false;
  for (const match of duration.matchAll(/(\d+)(hr|w|d|h|m|s)/g)) {
    totalMilliseconds += Number(match[1]) * DURATION_UNIT_TO_MS[match[2]];
    hasMatch = true;
  }

  return hasMatch ? totalMilliseconds : undefined;
}

export function parseNaturalLanguageDuration(duration: string): Date | undefined {
  const ms = parseNaturalLanguageDurationInMs(duration);
  return ms !== undefined ? new Date(Date.now() + ms) : undefined;
}

export function safeParseNaturalLanguageDuration(duration: string): Date | undefined {
  try {
    return parseNaturalLanguageDuration(duration);
  } catch (_error) {
    return undefined;
  }
}

// ... existing code ...

export function parseNaturalLanguageDurationAgo(duration: string): Date | undefined {
  // Handle Code scanning alert #44 (https://github.com/triggerdotdev/trigger.dev/security/code-scanning/44) by limiting the length of the input string
  if (duration.length > 100) {
    return undefined;
  }

  // More flexible regex that captures all units individually regardless of order
  const weekMatch = duration.match(/(\d+)w/);
  const dayMatch = duration.match(/(\d+)d/);
  const hourMatch = duration.match(/(\d+)(?:hr|h)/);
  const minuteMatch = duration.match(/(\d+)m/);
  const secondMatch = duration.match(/(\d+)s/);

  // Check if the entire string consists only of valid duration units
  const validPattern = /^(\d+(?:w|d|hr|h|m|s))+$/;
  if (!validPattern.test(duration)) {
    return undefined;
  }

  let totalMilliseconds = 0;
  let hasMatch = false;

  if (weekMatch) {
    const weeks = Number(weekMatch[1]);
    if (weeks >= 0) {
      totalMilliseconds += weeks * 7 * 24 * 60 * 60 * 1000;
      hasMatch = true;
    }
  }

  if (dayMatch) {
    const days = Number(dayMatch[1]);
    if (days >= 0) {
      totalMilliseconds += days * 24 * 60 * 60 * 1000;
      hasMatch = true;
    }
  }

  if (hourMatch) {
    const hours = Number(hourMatch[1]);
    if (hours >= 0) {
      totalMilliseconds += hours * 60 * 60 * 1000;
      hasMatch = true;
    }
  }

  if (minuteMatch) {
    const minutes = Number(minuteMatch[1]);
    if (minutes >= 0) {
      totalMilliseconds += minutes * 60 * 1000;
      hasMatch = true;
    }
  }

  if (secondMatch) {
    const seconds = Number(secondMatch[1]);
    if (seconds >= 0) {
      totalMilliseconds += seconds * 1000;
      hasMatch = true;
    }
  }

  if (hasMatch) {
    return new Date(Date.now() - totalMilliseconds);
  }

  return undefined;
}

export function safeParseNaturalLanguageDurationAgo(duration: string): Date | undefined {
  try {
    return parseNaturalLanguageDurationAgo(duration);
  } catch (_error) {
    return undefined;
  }
}

export function stringifyDuration(seconds: number): string | undefined {
  if (seconds <= 0) {
    return;
  }

  const units = {
    w: Math.floor(seconds / 604800),
    d: Math.floor((seconds % 604800) / 86400),
    h: Math.floor((seconds % 86400) / 3600),
    m: Math.floor((seconds % 3600) / 60),
    s: Math.floor(seconds % 60),
  };

  // Filter the units having non-zero values and join them
  const result: string = Object.entries(units)
    .filter(([unit, val]) => val != 0)
    .map(([unit, val]) => `${val}${unit}`)
    .join("");

  return result;
}
