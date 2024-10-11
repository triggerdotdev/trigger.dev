import RunButton from "@/components/RunButton";
import BatchRunButton from "@/components/BatchRunButton";
import { ImageUploadButton, ImageUploadDropzone } from "@/components/ImageUploadButton";

export default function Home() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <div className="flex flex-col space-y-4">
        {/* <RunButton />
        <BatchRunButton /> */}
        <ImageUploadDropzone />
      </div>
    </main>
  );
}
