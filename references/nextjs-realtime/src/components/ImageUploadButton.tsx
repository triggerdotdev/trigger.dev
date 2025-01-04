"use client";

import { UploadButton, UploadDropzone } from "@/utils/uploadthing";
import { useRouter } from "next/navigation";

export function ImageUploadButton() {
  const router = useRouter();

  return (
    <UploadButton
      endpoint="imageUploader"
      onClientUploadComplete={(res) => {
        // Do something with the response
        console.log("Files: ", res);

        const firstFile = res[0];

        router.push(
          `/uploads/${firstFile.serverData.fileId}?publicAccessToken=${firstFile.serverData.publicAccessToken}`
        );
      }}
      onUploadError={(error: Error) => {
        // Do something with the error.
        console.error(`ERROR! ${error.message}`);
      }}
    />
  );
}

export function ImageUploadDropzone() {
  const router = useRouter();

  return (
    <UploadDropzone
      endpoint="imageUploader"
      onClientUploadComplete={(res) => {
        // Do something with the response
        console.log("Files: ", res);

        const firstFile = res[0];

        router.push(
          `/uploads/${firstFile.serverData.fileId}?publicAccessToken=${firstFile.serverData.publicAccessToken}`
        );
      }}
      onUploadError={(error: Error) => {
        // Do something with the error.
        console.error(`ERROR! ${error.message}`);
      }}
      className="border-gray-600"
    />
  );
}

export function CSVUploadDropzone() {
  const router = useRouter();

  return (
    <UploadDropzone
      endpoint="csvUploader"
      onClientUploadComplete={(res) => {
        // Do something with the response
        console.log("Files: ", res);

        const firstFile = res[0];

        router.push(
          `/csv/${firstFile.serverData.id}?publicAccessToken=${firstFile.serverData.publicAccessToken}`
        );
      }}
      onUploadError={(error: Error) => {
        // Do something with the error.
        console.error(`ERROR! ${error.message}`);
      }}
      className="border-gray-600"
    />
  );
}
