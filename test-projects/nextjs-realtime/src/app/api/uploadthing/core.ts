import { randomUUID } from "crypto";
import { createUploadthing, type FileRouter } from "uploadthing/next";
import { UploadThingError } from "uploadthing/server";
import type { handleUpload } from "@/trigger/images";
import type { handleCSVUpload } from "@/trigger/csv";
import { auth, tasks } from "@trigger.dev/sdk/v3";

const f = createUploadthing();

const mockAuth = (req: Request) => ({ id: randomUUID() }); // Fake auth function

// FileRouter for your app, can contain multiple FileRoutes
export const ourFileRouter = {
  // Define as many FileRoutes as you like, each with a unique routeSlug
  imageUploader: f({ image: { maxFileSize: "4MB" } })
    // Set permissions and file types for this FileRoute
    .middleware(async ({ req }) => {
      // This code runs on your server before upload
      const user = await mockAuth(req);

      // If you throw, the user will not be able to upload
      if (!user) throw new UploadThingError("Unauthorized");

      // Whatever is returned here is accessible in onUploadComplete as `metadata`
      return { userId: user.id };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // This code RUNS ON YOUR SERVER after upload
      console.log("Upload complete for userId:", metadata.userId);

      console.log("file", file);

      const fileTag = `file:${file.key}`;

      await tasks.trigger<typeof handleUpload>("handle-upload", file, {
        tags: [`user:${metadata.userId}`, fileTag],
      });

      const publicAccessToken = await auth.createPublicToken({
        scopes: {
          read: { tags: fileTag },
        },
      });

      console.log("Generated access token:", publicAccessToken);

      // !!! Whatever is returned here is sent to the clientside `onClientUploadComplete` callback
      return { uploadedBy: metadata.userId, publicAccessToken, fileId: file.key };
    }),
  csvUploader: f({ blob: { maxFileSize: "4MB" } }).onUploadComplete(async ({ metadata, file }) => {
    console.log("file", file);

    const handle = await tasks.trigger<typeof handleCSVUpload>("handle-csv-upload", file);

    return handle;
  }),
} satisfies FileRouter;

export type OurFileRouter = typeof ourFileRouter;
