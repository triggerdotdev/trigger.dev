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
      <div className="w-full min-h-screen bg-gray-100 p-4">
        <Card className="w-full bg-white shadow-md">
          <CardContent className="pt-6">
            <p className="text-red-600">Error: {error.message}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="w-full min-h-screen bg-gray-100 p-4">
        <Card className="w-full bg-white shadow-md">
          <CardContent className="pt-6">
            <p>Loading run details...</p>
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
    <div className="w-full min-h-screen bg-gray-100 p-4 space-y-6">
      <ImageDisplay
        uploadedImage={run.payload.appUrl}
        uploadedCaption={run.payload.name}
        gridImages={gridImages}
      />

      <HandleUploadFooter
        run={run}
        viewRunUrl={`http://localhost:3030/projects/v3/proj_bzhdaqhlymtuhlrcgbqy/runs/${run.id}`}
      />
    </div>
  );
}

export default function ClientUploadDetails({ fileId, jwt }: { fileId: string; jwt: string }) {
  return (
    <TriggerAuthContext.Provider value={{ accessToken: jwt, baseURL: "http://localhost:3030" }}>
      <UploadDetailsWrapper fileId={fileId} />
    </TriggerAuthContext.Provider>
  );
}
