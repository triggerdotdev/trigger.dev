import { z } from "zod";

export interface MessageCatalogSchema {
  [key: string]: {
    data: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;
    properties: z.ZodObject<z.ZodRawShape> | z.ZodUndefined;
  };
}
