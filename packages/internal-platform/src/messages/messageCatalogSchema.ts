import { z } from "zod";

export const MessageDataSchema = z.object({
  data: z.any(),
  id: z.string(),
  type: z.string(),
});

export type MessageData = z.infer<typeof MessageDataSchema>;

export interface MessageCatalogSchema {
  [key: string]: {
    data: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;
    properties: z.ZodObject<z.ZodRawShape> | z.ZodUndefined;
  };
}
