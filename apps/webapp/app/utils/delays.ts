import { parseNaturalLanguageDuration } from "@trigger.dev/core/v3/isomorphic";

export const calculateDurationInMs = (options: {
  seconds?: number;
  minutes?: number;
  hours?: number;
  days?: number;
}) => {
  return (
    (options?.seconds ?? 0) * 1000 +
    (options?.minutes ?? 0) * 60 * 1000 +
    (options?.hours ?? 0) * 60 * 60 * 1000 +
    (options?.days ?? 0) * 24 * 60 * 60 * 1000
  );
};

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
  } catch (error) {
    return parseNaturalLanguageDuration(value);
  }
}
