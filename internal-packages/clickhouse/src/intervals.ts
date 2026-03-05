/** Converts a granularity in milliseconds to a ClickHouse INTERVAL expression. */
export function msToClickHouseInterval(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `INTERVAL ${seconds} SECOND`;
}
