import { useShape } from "@electric-sql/react";
import { TaskRun } from "@trigger.dev/database";

type Params = {
  origin: string;
  runId: string;
};

export function useSyncRun({ origin, runId }: Params) {
  const { isUpToDate, data } = useShape({
    url: `${origin}/sync/runs/${runId}`,
  });

  const run = (data as unknown as TaskRun[])?.at(0);

  return { isUpToDate, run };
}
