import { z } from "zod";

export const GetProjectDevResponse = z.object({
  apiKey: z.string(),
});

export type GetProjectDevResponse = z.infer<typeof GetProjectDevResponse>;
