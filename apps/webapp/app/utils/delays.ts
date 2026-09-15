import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/isomorphic";

export async function parseDelay(value?: string | Date): Promise<Date | undefined> {
  if (!value) {
    return;
  }

  if (value instanceof Date) {
    return value;
  }

  try {
    const date = new Date(value);

    // Check if the date is valid
    if (isNaN(date.getTime())) {
      return parseNaturalLanguageDuration(value);
    }

    if (date.getTime() <= Date.now()) {
      return;
    }

    return date;
  } catch (_error) {
    return parseNaturalLanguageDuration(value);
  }
}
