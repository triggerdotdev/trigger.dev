const LOGS_SEARCH_INITIAL_SLICE_MS = 60 * 60 * 1000;
const LOGS_SEARCH_MIN_SLICE_MS = 5 * 60 * 1000;
const LOGS_SEARCH_TARGET_SLICE_MS = 2_500;
const LOGS_SEARCH_FIXED_COST_MS = 1_500;

export type LogsSearchKeyset = {
  triggeredTimestamp: string;
  traceId: string;
  spanId: string;
  projectionFingerprint: string;
};

export type LogsSearchSlice = {
  anchorTime: number;
  sliceFrom: number;
  sliceTo: number;
  upperInclusive: boolean;
  remainingUpper: number;
  pendingSliceFrom?: number;
  keyset?: LogsSearchKeyset;
  rowsPerHour?: number;
  sliceIndex: number;
};

export type LogsSearchSliceStats = {
  readRows: number;
  elapsedMs: number;
};

export function logsSearchRangeFrom(
  anchorTime: number,
  options: { periodMs: number; explicitFrom?: number; retentionFloor?: number }
): number {
  const relativeFrom = Math.trunc(Math.max(0, anchorTime - options.periodMs));
  return Math.max(options.explicitFrom ?? relativeFrom, options.retentionFloor ?? 0);
}

export function logsSearchRangeTo(anchorTime: number, explicitTo?: number): number {
  return Math.max(0, Math.min(anchorTime, explicitTo ?? anchorTime));
}

export function rebaseLogsSearchSliceToRange(
  slice: LogsSearchSlice,
  rangeFrom: number,
  rangeTo: number,
  now: number
): LogsSearchSlice | "expired" | undefined {
  if (
    slice.anchorTime > now ||
    slice.sliceFrom > slice.remainingUpper ||
    slice.remainingUpper > slice.sliceTo ||
    slice.sliceTo > rangeTo ||
    (slice.pendingSliceFrom !== undefined && slice.pendingSliceFrom > slice.sliceFrom)
  ) {
    return undefined;
  }

  if (rangeFrom > rangeTo || slice.remainingUpper < rangeFrom) {
    return "expired";
  }

  const sliceFrom = Math.max(slice.sliceFrom, rangeFrom);
  const pendingSliceFrom =
    slice.pendingSliceFrom === undefined ? undefined : Math.max(slice.pendingSliceFrom, rangeFrom);

  return {
    ...slice,
    sliceFrom,
    pendingSliceFrom:
      pendingSliceFrom !== undefined && pendingSliceFrom < sliceFrom ? pendingSliceFrom : undefined,
  };
}

function clampSliceFrom(rangeFrom: number, sliceTo: number, durationMs: number): number {
  return Math.max(rangeFrom, Math.floor(sliceTo - Math.max(LOGS_SEARCH_MIN_SLICE_MS, durationMs)));
}

export function initialLogsSearchSlice(
  rangeFrom: Date,
  rangeTo: Date,
  anchorTime = rangeTo.getTime()
): LogsSearchSlice {
  const rangeFromMs = rangeFrom.getTime();
  const rangeToMs = rangeTo.getTime();

  return {
    anchorTime,
    sliceFrom: clampSliceFrom(rangeFromMs, rangeToMs, LOGS_SEARCH_INITIAL_SLICE_MS),
    sliceTo: rangeToMs,
    upperInclusive: true,
    remainingUpper: rangeToMs,
    sliceIndex: 0,
  };
}

export function clickhouseTimestampCeilMs(value: string): number {
  const match = value.match(/^(.*?)(?:\.(\d{1,9}))?$/);
  if (!match) return Number.NaN;

  const base = match[1]!.replace(" ", "T");
  const fraction = (match[2] ?? "").padEnd(9, "0");
  const milliseconds = fraction.slice(0, 3);
  const parsed = Date.parse(`${base}.${milliseconds}Z`);
  if (!Number.isFinite(parsed)) return Number.NaN;

  return parsed + (/[^0]/.test(fraction.slice(3)) ? 1 : 0);
}

export function continueLogsSearchSlice(
  slice: LogsSearchSlice,
  keyset: LogsSearchKeyset
): LogsSearchSlice {
  const remainingUpper = clickhouseTimestampCeilMs(keyset.triggeredTimestamp);

  return {
    ...slice,
    remainingUpper: Number.isFinite(remainingUpper) ? remainingUpper : slice.remainingUpper,
    keyset,
  };
}

export function retryTimedOutLogsSearchSlice(slice: LogsSearchSlice): LogsSearchSlice | undefined {
  const remainingDuration = Math.max(0, slice.remainingUpper - slice.sliceFrom);
  if (remainingDuration <= LOGS_SEARCH_MIN_SLICE_MS) {
    return undefined;
  }

  return {
    ...slice,
    pendingSliceFrom: slice.pendingSliceFrom ?? slice.sliceFrom,
    sliceFrom: Math.max(
      slice.sliceFrom,
      Math.floor(slice.remainingUpper - Math.max(LOGS_SEARCH_MIN_SLICE_MS, remainingDuration / 2))
    ),
  };
}

export function nextLogsSearchSlice(
  slice: LogsSearchSlice,
  rangeFrom: number,
  stats: LogsSearchSliceStats
): LogsSearchSlice | undefined {
  if (slice.sliceFrom <= rangeFrom) return undefined;

  const rowsPerHour = updateRowsPerHour(slice, stats);
  const remainingRangeMs = slice.sliceFrom - rangeFrom;
  const nextDurationMs = estimateNextSliceDurationMs(rowsPerHour, stats, remainingRangeMs);
  const sliceFrom =
    slice.pendingSliceFrom ?? clampSliceFrom(rangeFrom, slice.sliceFrom, nextDurationMs);

  return {
    ...slice,
    sliceFrom,
    sliceTo: slice.sliceFrom,
    upperInclusive: false,
    remainingUpper: slice.sliceFrom,
    pendingSliceFrom: undefined,
    keyset: undefined,
    rowsPerHour,
    sliceIndex: slice.sliceIndex + 1,
  };
}

function updateRowsPerHour(
  slice: LogsSearchSlice,
  { readRows }: LogsSearchSliceStats
): number | undefined {
  const durationHours =
    Math.max(LOGS_SEARCH_MIN_SLICE_MS, slice.remainingUpper - slice.sliceFrom) / 3_600_000;
  const observedRowsPerHour = readRows / durationHours;
  if (!Number.isFinite(observedRowsPerHour)) return slice.rowsPerHour;
  if (slice.rowsPerHour === undefined) return observedRowsPerHour;

  return (slice.rowsPerHour + observedRowsPerHour) / 2;
}

function estimateNextSliceDurationMs(
  rowsPerHour: number | undefined,
  stats: LogsSearchSliceStats,
  remainingRangeMs: number
): number {
  const variableElapsedMs = stats.elapsedMs - LOGS_SEARCH_FIXED_COST_MS;
  if (!rowsPerHour || stats.readRows <= 0 || variableElapsedMs <= 0) {
    return remainingRangeMs;
  }

  const rowsPerVariableMs = stats.readRows / variableElapsedMs;
  const targetVariableMs = LOGS_SEARCH_TARGET_SLICE_MS - LOGS_SEARCH_FIXED_COST_MS;
  const targetRows = rowsPerVariableMs * targetVariableMs;
  const targetHours = targetRows / rowsPerHour;

  if (!Number.isFinite(targetHours) || targetHours <= 0) {
    return LOGS_SEARCH_MIN_SLICE_MS;
  }

  return Math.min(remainingRangeMs, Math.max(LOGS_SEARCH_MIN_SLICE_MS, targetHours * 3_600_000));
}

export function logsSearchRowsPerHourBucket(rowsPerHour: number | undefined): string {
  if (rowsPerHour === undefined) return "unknown";
  if (rowsPerHour < 10_000) return "lt_10k";
  if (rowsPerHour < 100_000) return "10k_100k";
  if (rowsPerHour < 1_000_000) return "100k_1m";
  return "gte_1m";
}
