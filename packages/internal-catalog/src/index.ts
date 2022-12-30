import { z } from "zod";
import { parseDocument } from "yaml";

const integrationMetadataSchema = z.object({
  name: z.string(),
  slug: z.string(),
  icon: z.string(),
});

const oAuthIntegrationAuthenticationSchema = z.object({
  type: z.literal("oauth"),
  scopes: z.array(z.string()),
  environments: z.record(z.object({ client_id: z.string() })),
});

const apiKeyIntegrationAuthenticationSchema = z.object({
  type: z.literal("api_key"),
  header_name: z.string(),
  header_type: z.string(),
  documentation: z.string(),
});

const integrationSchema = integrationMetadataSchema.extend({
  authentication: z.discriminatedUnion("type", [
    oAuthIntegrationAuthenticationSchema,
    apiKeyIntegrationAuthenticationSchema,
  ]),
});

const schema = z.array(integrationSchema);

type Catalog = z.infer<typeof schema>;
export type CatalogIntegration = Catalog[number];

export function getCatalog(raw: string) {
  const doc = parseDocument(raw);
  const jsObject = doc.toJS();
  return schema.parse(jsObject);
}
