import type { DetailWindow } from "~/components/alerts/alertDetailWindow";
import { windowBucketSeconds } from "~/v3/services/alerts/alertSeries.server";

const MIN_HEALTH_BUCKET_MS = 5 * 60 * 1000;

export function healthBucketMs(window: DetailWindow, cadenceSec: number): number {
  return Math.max(MIN_HEALTH_BUCKET_MS, windowBucketSeconds(window, cadenceSec) * 1000);
}
