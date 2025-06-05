export function parseNaturalLanguageDuration(duration: string): Date | undefined {
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
    return new Date(Date.now() + totalMilliseconds);
  }

  return undefined;
}

export function safeParseNaturalLanguageDuration(duration: string): Date | undefined {
  try {
    return parseNaturalLanguageDuration(duration);
  } catch (error) {
    return undefined;
  }
}

// ... existing code ...

export function parseNaturalLanguageDurationAgo(duration: string): Date | undefined {
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
  } catch (error) {
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
