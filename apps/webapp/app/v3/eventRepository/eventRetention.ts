export const DEFAULT_EVENT_RETENTION_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function eventExpiresAt(retentionDays: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + retentionDays * MS_PER_DAY);
}
