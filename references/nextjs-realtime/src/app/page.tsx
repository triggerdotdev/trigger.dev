import RunButton from "@/components/RunButton";
import BatchRunButton from "@/components/BatchRunButton";
import TriggerButton from "@/components/TriggerButton";
import TriggerButtonWithStreaming from "@/components/TriggerButtonWithStreaming";
import { ImageUploadDropzone } from "@/components/ImageUploadButton";
import { auth } from "@trigger.dev/sdk/v3";

export default async function Home() {
  const publicAccessToken = await auth.createTriggerPublicToken("openai-streaming");

  return (
    <main className="grid grid-rows-[1fr_auto] min-h-screen items-center justify-center w-full bg-gray-900">
      <div className="flex flex-col space-y-8">
        <h1 className="text-gray-200 text-4xl max-w-xl text-center font-bold">
          Trigger.dev Realtime + UploadThing + fal.ai
        </h1>
        <ImageUploadDropzone />
      </div>
      <div className="flex items-center space-x-4 justify-center w-full">
        <RunButton />
        <BatchRunButton />
        <TriggerButton accessToken={publicAccessToken} />
        <TriggerButtonWithStreaming accessToken={publicAccessToken} />
      </div>
    </main>
  );
}
