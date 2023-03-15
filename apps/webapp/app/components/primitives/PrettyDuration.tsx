// Formats duration in a human readable way, some examples:
// 1h 30m
// 1m 30s
// 1h
// Uses built-in plain Date object, so it's not timezone aware
export function PrettyDuration({
  startAt,
  endAt,
  fallback,
}: {
  startAt?: Date | null;
  endAt?: Date | null;
  fallback?: string;
}) {
  if (!startAt || !endAt) {
    return <>{fallback ?? "-"}</>;
  }

  const duration = Math.abs(endAt.getTime() - startAt.getTime());

  const hours = Math.floor(duration / (1000 * 60 * 60));
  const minutes = Math.floor((duration / (1000 * 60)) % 60);
  const seconds = Math.floor((duration / 1000) % 60);

  const durationParts = [];

  if (hours > 0) {
    durationParts.push(`${hours}h`);
  }

  if (minutes > 0) {
    durationParts.push(`${minutes}m`);
  }

  if (seconds > 0) {
    durationParts.push(`${seconds}s`);
  }

  return <>{durationParts.join(" ")}</>;
}
