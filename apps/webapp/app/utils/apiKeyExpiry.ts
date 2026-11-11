export const DEFAULT_API_KEY_EXPIRY_DAYS = 90;

// Calendar dates use local components, but the day being represented is a UTC day.
export function apiKeyExpiryDay(now = new Date(), days = 0): Date {
  return new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days);
}

export function apiKeyExpiryTimestamp(date: Date): Date {
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() + 1));
}

export function isApiKeyExpiryDayExpired(date: Date, now = new Date()): boolean {
  return apiKeyExpiryTimestamp(date).getTime() <= now.getTime();
}

/**
 * The day a stored expiry ends on: "7 Feb 2027" for 2027-02-08T00:00Z, since keys expire at the
 * end of the chosen UTC day. Undefined when the expiry isn't at a UTC midnight (set some other way).
 */
export function apiKeyExpiryEndDay(expiresAt: Date | string): string | undefined {
  const time = new Date(expiresAt).getTime();
  if (time % 86_400_000 !== 0) return undefined;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(time - 86_400_000));
}

/** The expiry as the create dialog showed it: "7 Feb 2027 (end of day, UTC)". */
export function apiKeyExpiryDayLabel(expiresAt: Date | string): string | undefined {
  const day = apiKeyExpiryEndDay(expiresAt);
  return day ? `${day} (end of day, UTC)` : undefined;
}
