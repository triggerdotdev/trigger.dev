import { CSVUploadDropzone } from "@/components/ImageUploadButton";

export default async function CSVPage() {
  return (
    <main className="grid grid-rows-[1fr_auto] min-h-screen items-center justify-center w-full bg-gray-900">
      <div className="flex flex-col space-y-8">
        <h1 className="text-gray-200 text-4xl max-w-xl text-center font-bold">
          Trigger.dev Realtime + UploadThing + CSV Import
        </h1>
        <CSVUploadDropzone />
      </div>
    </main>
  );
}
