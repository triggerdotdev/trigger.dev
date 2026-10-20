import { formatDistanceToNow } from "date-fns";

export function formatExpiresAt(expiresAt: Date | null): string {
  if (!expiresAt) return "–";

  const now = new Date();
  const isExpired = expiresAt <= now;

  if (isExpired) {
    return `expired ${formatDistanceToNow(expiresAt)} ago`;
  }

  return `in ${formatDistanceToNow(expiresAt)}`;
}
