import { z } from "zod";

const IndexEndpointStatsSchema = z.object({
  jobs: z.number(),
  sources: z.number(),
  dynamicTriggers: z.number(),
  dynamicSchedules: z.number(),
});

export type IndexEndpointStats = z.infer<typeof IndexEndpointStatsSchema>;

export function parseEndpointIndexStats(stats: unknown): IndexEndpointStats {
  return IndexEndpointStatsSchema.parse(stats);
}
