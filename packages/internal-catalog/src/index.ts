import { z } from "zod";
import { parseDocument } from "yaml";

const schema = z.array(
  z.object({
    name: z.string(),
    slug: z.string(),
    icon: z.string(),
    scopes: z.array(z.string()),
    environments: z.record(
      z.object({ oauth: z.object({ client_id: z.string() }) })
    ),
  })
);

type Catalog = z.infer<typeof schema>;
export type CatalogIntegration = Catalog[number];

export function getCatalog(raw: string) {
  const doc = parseDocument(raw);
  const jsObject = doc.toJS();
  return schema.parse(jsObject);
}
