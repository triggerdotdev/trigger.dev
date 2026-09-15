/**
 * X-axis tick + tooltip label formatters for the task/agent activity charts.
 * ClickHouse buckets are UTC-aligned, so labels are formatted in UTC (local time
 * causes off-by-one day labels). Tick selection itself lives in useXAxisTicks.
 */

const ONE_MINUTE = 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

type ActivityPoint = Record<string, unknown>;

/**
 * `rangeMs` overrides the data-derived span, for a chart whose axis is wider than its data.
 * `xKey` is the point's timestamp field, for data that keys it as something other than `bucket`.
 */
export function buildActivityTimeAxis(data: ActivityPoint[], rangeMs?: number, xKey = "bucket") {
  const at = (index: number) => data[index]?.[xKey] as number;
  const range = rangeMs ?? (data.length >= 2 ? at(data.length - 1) - at(0) : 0);
  const bucketMs = data.length >= 2 ? at(1) - at(0) : 0;

  // ≤ 1 day range → clock time, otherwise date.
  const showTime = range <= ONE_DAY;
  // Sub-minute buckets need seconds, or adjacent ticks collapse to the same "HH:MM".
  const showSeconds = bucketMs > 0 && bucketMs < ONE_MINUTE;
  const isSubDayBucket = bucketMs > 0 && bucketMs < ONE_DAY;

  const tickFormatter = (value: number) => {
    const date = new Date(value);
    if (showTime) {
      return date.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        ...(showSeconds ? { second: "2-digit" } : {}),
        hour12: false,
        timeZone: "UTC",
      });
    }
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  };

  const tooltipLabelFormatter = (_label: string, payload: { payload?: ActivityPoint }[]) => {
    const ts = payload?.[0]?.payload?.[xKey];
    if (typeof ts !== "number" || !Number.isFinite(ts)) return _label;
    const date = new Date(ts);
    return isSubDayBucket
      ? date.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          ...(showSeconds ? { second: "2-digit" } : {}),
          hour12: false,
          timeZone: "UTC",
        })
      : date.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        });
  };

  return { tickFormatter, tooltipLabelFormatter };
}
