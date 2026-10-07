// Progressive loading only runs with the live tail: without it every stream ping would
// reset and re-download the tree. The env switch turns both off, and only the v2 store
// has the write time the tail pages by.
export function canLiveTail(envSwitch: string, taskEventStore: string): boolean {
  return envSwitch === "1" && taskEventStore === "clickhouse_v2";
}

export function hasWriteTimes(events: { insertedAt?: string }[]): boolean {
  return events.length > 0 && events.every((event) => event.insertedAt !== undefined);
}
