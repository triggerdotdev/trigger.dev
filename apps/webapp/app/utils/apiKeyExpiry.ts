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
