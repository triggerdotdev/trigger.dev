// Progressive loading only runs with the live tail (without it every stream ping would
// reset and re-download the tree), and only the v2 store has the write time it pages by.
// The emergency span cap turns both off, so new loads take the summary path that honours it.
export function canLiveTail(taskEventStore: string, emergencySpanCap: number | undefined): boolean {
  return taskEventStore === "clickhouse_v2" && emergencySpanCap === undefined;
}

export function hasWriteTimes(events: { insertedAt?: string }[]): boolean {
  return events.length > 0 && events.every((event) => event.insertedAt !== undefined);
}
