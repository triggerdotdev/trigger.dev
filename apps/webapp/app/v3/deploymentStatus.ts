import { WorkerDeployment } from "@trigger.dev/database";

export const deploymentIndexingIsRetryable = ({
  builtAt,
  status,
}: {
  builtAt: Date | null;
  status: WorkerDeployment["status"];
}) => {
  return builtAt && (status === "FAILED" || status === "TIMED_OUT");
};
