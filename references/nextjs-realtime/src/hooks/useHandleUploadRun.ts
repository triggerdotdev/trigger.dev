import type { handleUpload, runFalModel } from "@/trigger/images";
import { RunFalMetadata } from "@/utils/schemas";
import { useRealtimeRunsWithTag } from "@trigger.dev/react-hooks";

export function useHandleUploadRun(fileId: string) {
  const { runs, error } = useRealtimeRunsWithTag<typeof handleUpload | typeof runFalModel>(
    `file:${fileId}`
  );

  const images = runs
    .filter((run) => run.taskIdentifier === "run-fal-model")
    .map((run) => {
      const metadata = RunFalMetadata.default({ result: { status: "IN_PROGRESS" } }).parse(
        run.metadata
      );

      return {
        model: run.payload.model,
        data: metadata?.result,
      };
    });

  const run = runs.find((run) => run.taskIdentifier === "handle-upload");

  return { run, error, images };
}
