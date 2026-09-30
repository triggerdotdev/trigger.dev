export const SUPPORT_ACCESS_APPROVAL_DAYS = 7;
const SUPPORT_ACCESS_PENDING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function pendingRequestCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - SUPPORT_ACCESS_PENDING_DAYS * DAY_MS);
}
