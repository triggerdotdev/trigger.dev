"use client";

import { HandleUploadFooter } from "@/components/HandleUploadFooter";
import { Card, CardContent } from "@/components/ui/card";
import ImageDisplay from "@/components/UploadImageDisplay";
import { useHandleUploadRun } from "@/hooks/useHandleUploadRun";
import { TriggerAuthContext } from "@trigger.dev/react-hooks";

function UploadDetailsWrapper({ fileId }: { fileId: string }) {
  const { run, error, images } = useHandleUploadRun(fileId);

  if (error) {
    return (
      <div className="w-full min-h-screen bg-gray-900 p-4">
        <Card className="w-full bg-gray-800 shadow-md">
          <CardContent className="pt-6">
            <p className="text-red-600">Error: {error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="w-full min-h-screen bg-gray-900 py-4 px-8 grid place-items-center">
        <Card className="w-fit bg-gray-800 border border-gray-700 shadow-md">
          <CardContent className="pt-6">
            <p className="text-gray-200">Loading run details…</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const gridImages = images.map((image) =>
    image.data.status === "COMPLETED" && image.data.image
      ? {
          status: "completed" as const,
          src: image.data.image.url,
          caption: image.data.image.file_name,
          message: image.model,
        }
      : { status: "pending" as const, message: image.model }
  );

  return (
    <div className="w-full min-h-screen bg-gray-900 text-gray-200 p-4 space-y-6">
      <ImageDisplay
        uploadedImage={run.payload.appUrl}
        uploadedCaption={run.payload.name}
        gridImages={gridImages}
      />

      <HandleUploadFooter
        run={run}
        viewRunUrl={`${process.env.NEXT_PUBLIC_TRIGGER_API_URL}/projects/v3/proj_bzhdaqhlymtuhlrcgbqy/runs/${run.id}`}
      />
    </div>
  );
}

export default function ClientUploadDetails({
  fileId,
  publicAccessToken,
}: {
  fileId: string;
  publicAccessToken: string;
}) {
  return (
    <TriggerAuthContext.Provider
      value={{ accessToken: publicAccessToken, baseURL: process.env.NEXT_PUBLIC_TRIGGER_API_URL }}
    >
      <UploadDetailsWrapper fileId={fileId} />
    </TriggerAuthContext.Provider>
  );
}
