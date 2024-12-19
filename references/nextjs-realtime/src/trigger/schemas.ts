import { z } from "zod";

export const CSVRow = z.object({
  Date: z.string(),
  Impressions: z.coerce.number(),
  Likes: z.coerce.number(),
  Engagements: z.coerce.number(),
  Bookmarks: z.coerce.number(),
  Shares: z.coerce.number(),
  "New follows": z.coerce.number(),
  Unfollows: z.coerce.number(),
  Replies: z.coerce.number(),
  Reposts: z.coerce.number(),
  "Profile visits": z.coerce.number(),
  "Create Post": z.coerce.number(),
  "Video views": z.coerce.number(),
  "Media views": z.coerce.number(),
});

export type CSVRow = z.infer<typeof CSVRow>;

// Status schema for progress updates
export const CSVStatus = z.enum(["fetching", "parsing", "processing", "complete"]);

export type CSVStatus = z.infer<typeof CSVStatus>;

// The full metadata schema that encompasses all possible metadata fields
export const CSVUploadMetadataSchema = z.object({
  status: CSVStatus,
  totalRows: z.number().int().nonnegative().optional(),
  inProgressRows: z.number().int().nonnegative().optional(),
  processedRows: z.number().int().nonnegative().optional(),
});

export type CSVUploadMetadata = z.infer<typeof CSVUploadMetadataSchema>;
