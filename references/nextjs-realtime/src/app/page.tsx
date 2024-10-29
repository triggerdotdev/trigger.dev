import RunButton from "@/components/RunButton";
import BatchRunButton from "@/components/BatchRunButton";
import { ImageUploadDropzone } from "@/components/ImageUploadButton";

export default function Home() {
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
      </div>
    </main>
  );
}
