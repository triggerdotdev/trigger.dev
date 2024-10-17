import { z } from "zod";

export const EnqueuedQueueStatus = z.object({
  status: z.literal("IN_QUEUE"),
  queue_position: z.number(),
});

export type EnqueuedQueueStatus = z.infer<typeof EnqueuedQueueStatus>;

export const InProgressGridImage = z.object({
  status: z.literal("IN_PROGRESS"),
});

export type InProgressGridImage = z.infer<typeof InProgressGridImage>;

export const ImageDetails = z.object({
  url: z.string(),
  file_name: z.string(),
});

export type ImageDetails = z.infer<typeof ImageDetails>;

export const CompletedGridImage = z.object({
  status: z.literal("COMPLETED"),
  metrics: z.object({
    inference_time: z.number().nullable(),
  }),
  image: ImageDetails.optional(),
});

export type CompletedGridImage = z.infer<typeof CompletedGridImage>;

export const GridImage = z.union([InProgressGridImage, CompletedGridImage, EnqueuedQueueStatus]);

export type GridImage = z.infer<typeof GridImage>;

export const HandleUploadMetadata = z.record(GridImage);
export type HandleUploadMetadata = z.infer<typeof HandleUploadMetadata>;

export const RunFalMetadata = z.object({ result: GridImage });
export type RunFalMetadata = z.infer<typeof RunFalMetadata>;

export const UploadedFileData = z.object({
  name: z.string(),
  size: z.number(),
  type: z.string(),
  key: z.string(),
  url: z.string(),
  appUrl: z.string(),
  fileHash: z.string(),
  customId: z.string().nullable(),
});

export type UploadedFileData = z.infer<typeof UploadedFileData>;

export const FalResult = z.object({
  image: ImageDetails,
});

export type FalResult = z.infer<typeof FalResult>;
