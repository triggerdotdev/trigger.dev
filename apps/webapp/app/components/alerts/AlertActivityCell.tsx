import type { AlertListRow } from "~/presenters/v3/alertListRow";
import { ActivityBlankState, StateBarsCell } from "./AlertListCells";

export function AlertActivityCell({
  stateBuckets,
}: {
  stateBuckets?: AlertListRow["stateBuckets"];
}) {
  if (!stateBuckets || stateBuckets.length === 0) {
    return <ActivityBlankState />;
  }
  return <StateBarsCell buckets={stateBuckets} />;
}
