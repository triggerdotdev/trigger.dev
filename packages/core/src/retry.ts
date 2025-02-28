export function calculateResetAt(
  resets: string | undefined | null,
  format:
    | "unix_timestamp"
    | "iso_8601"
    | "iso_8601_duration_openai_variant"
    | "unix_timestamp_in_ms",
  now: Date = new Date()
): Date | undefined {
  if (!resets) return;

  switch (format) {
    case "iso_8601_duration_openai_variant": {
      return calculateISO8601DurationOpenAIVariantResetAt(resets, now);
    }
    case "iso_8601": {
      return calculateISO8601ResetAt(resets, now);
    }
    case "unix_timestamp": {
      return calculateUnixTimestampResetAt(resets, now);
    }
    case "unix_timestamp_in_ms": {
      return calculateUnixTimestampInMsResetAt(resets, now);
    }
  }
}

function calculateUnixTimestampResetAt(resets: string, now: Date = new Date()): Date | undefined {
  // Check if the input is null or undefined
  if (!resets) return undefined;

  // Convert the string to a number
  const resetAt = parseInt(resets, 10);

  // If the string doesn't match the expected format, return undefined
  if (isNaN(resetAt)) return undefined;

  // Return the date
  return new Date(resetAt * 1000);
}

function calculateUnixTimestampInMsResetAt(
  resets: string,
  now: Date = new Date()
): Date | undefined {
  // Check if the input is null or undefined
  if (!resets) return undefined;

  // Convert the string to a number
  const resetAt = parseInt(resets, 10);

  // If the string doesn't match the expected format, return undefined
  if (isNaN(resetAt)) return undefined;

  // Return the date
  return new Date(resetAt);
}

function calculateISO8601ResetAt(resets: string, now: Date = new Date()): Date | undefined {
  // Check if the input is null or undefined
  if (!resets) return undefined;

  // Parse the date
  const resetAt = new Date(resets);

  // If the string doesn't match the expected format, return undefined
  if (isNaN(resetAt.getTime())) return undefined;

  return resetAt;
}

function calculateISO8601DurationOpenAIVariantResetAt(
  resets: string,
  now: Date = new Date()
): Date | undefined {
  // Check if the input is null or undefined
  if (!resets) return undefined;

  // Regular expression to match the duration string pattern
  const pattern = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$/;
  const match = resets.match(pattern);

  // If the string doesn't match the expected format, return undefined
  if (!match) return undefined;

  // Extract days, hours, minutes, seconds, and milliseconds from the string
  const days = parseInt(match[1] ?? "0", 10) || 0;
  const hours = parseInt(match[2] ?? "0", 10) || 0;
  const minutes = parseInt(match[3] ?? "0", 10) || 0;
  const seconds = parseFloat(match[4] ?? "0") || 0;
  const milliseconds = parseInt(match[5] ?? "0", 10) || 0;

  // Calculate the future date based on the current date plus the extracted time
  const resetAt = new Date(now);
  resetAt.setDate(resetAt.getDate() + days);
  resetAt.setHours(resetAt.getHours() + hours);
  resetAt.setMinutes(resetAt.getMinutes() + minutes);
  resetAt.setSeconds(resetAt.getSeconds() + Math.floor(seconds));
  resetAt.setMilliseconds(
    resetAt.getMilliseconds() + (seconds - Math.floor(seconds)) * 1000 + milliseconds
  );

  return resetAt;
}
