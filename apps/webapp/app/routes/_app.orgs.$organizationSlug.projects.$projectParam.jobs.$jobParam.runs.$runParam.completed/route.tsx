import { RunCompletedDetail } from "~/components/run/RunCompletedDetail";
import { useRun } from "~/hooks/useRun";

export default function RunCompletedPage() {
  const run = useRun();

  return <RunCompletedDetail run={run} />;
}
