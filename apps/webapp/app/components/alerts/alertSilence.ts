const BUCKET_MINUTES = 5;

export type SilenceWindow = {
  fromIndex: number;
  toIndex: number;
  minutes: number;
  windowMinutes: number;
};

function silenceIn(
  activity: number[],
  windowMinutes: number | undefined,
  bucketMinutes = BUCKET_MINUTES
): SilenceWindow | undefined {
  if (activity.length === 0 || windowMinutes === undefined) return undefined;

  let fromIndex = activity.length;
  while (fromIndex > 0 && activity[fromIndex - 1] === 0) fromIndex -= 1;
  const minutes = (activity.length - fromIndex) * bucketMinutes;
  if (minutes < windowMinutes) return undefined;

  return {
    fromIndex: Math.max(0, fromIndex - 1),
    toIndex: activity.length - 1,
    minutes,
    windowMinutes,
  };
}

export type TrailingSilence = { since: Date; now: Date };

export function observedSilence(
  buckets: { at: number; count: number }[],
  windowMinutes: number,
  trailing?: TrailingSilence
): SilenceWindow | undefined {
  const fromBuckets =
    buckets.length < 2
      ? undefined
      : silenceIn(
          buckets.map((b) => b.count),
          windowMinutes,
          (buckets[1]!.at - buckets[0]!.at) / 60_000
        );
  if (!trailing) return fromBuckets;
  const minutes = Math.round((trailing.now.getTime() - trailing.since.getTime()) / 60_000);
  if (minutes < windowMinutes) return fromBuckets;
  const at = trailing.since.getTime();
  const containing = buckets.findIndex(
    (b, i) => b.at <= at && (buckets[i + 1] === undefined || buckets[i + 1]!.at > at)
  );
  return {
    fromIndex: containing === -1 ? 0 : containing,
    toIndex: Math.max(0, buckets.length - 1),
    minutes,
    windowMinutes,
  };
}
