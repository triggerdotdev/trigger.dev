import type { AlertStateBucket } from "~/presenters/v3/alertListRow";
import { ActivityBlankState, StateBarsCell } from "./AlertListCells";

export function AlertActivityCell({ stateBuckets }: { stateBuckets?: AlertStateBucket[] }) {
  if (!stateBuckets || stateBuckets.length === 0) {
    return <ActivityBlankState />;
  }
  return <StateBarsCell buckets={stateBuckets} />;
}
