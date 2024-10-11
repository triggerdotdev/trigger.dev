import type { handleUpload } from "@/trigger/images";
import { HandleUploadMetadata } from "@/utils/schemas";
import { useRun } from "@trigger.dev/react-hooks";

export function useHandleUploadRun(runId: string) {
  const { run, error } = useRun<typeof handleUpload>(runId);

  const metadata = run?.metadata ? HandleUploadMetadata.parse(run.metadata) : undefined;

  const images = metadata
    ? Object.keys(metadata).map((key) => ({ model: key, data: metadata[key] }))
    : [];

  return { run, error, images };
}
