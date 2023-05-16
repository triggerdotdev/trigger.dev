import type { z } from "zod";

// TODO: https://twitter.com/mattpocockuk/status/1658431146500276226
export interface MessageCatalogSchema {
  [key: string]: z.ZodFirstPartySchemaTypes | z.ZodDiscriminatedUnion<any, any>;
}
