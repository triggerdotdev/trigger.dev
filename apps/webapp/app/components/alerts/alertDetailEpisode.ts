import type { AlertEpisode } from "./alertStateOutcome";

export function absenceSilenceStart(alert: {
  status: { status: string };
  episode: AlertEpisode;
  windowSec?: number;
}): Date | null {
  const { raisedAt, recoveredAt } = alert.episode;
  if (alert.status.status !== "needs_attention" || !raisedAt || recoveredAt) return null;
  return new Date(raisedAt.getTime() - (alert.windowSec ?? 0) * 1000);
}
