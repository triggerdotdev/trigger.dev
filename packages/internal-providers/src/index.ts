import { z } from "zod";
import { parseDocument } from "yaml";
import invariant from "tiny-invariant";

const enabledForSchema = z.union([
  z.literal("all"),
  z.literal("admins"),
  z.literal("none"),
]);

type EnabledFor = z.infer<typeof enabledForSchema>;

const integrationMetadataSchema = z.object({
  name: z.string(),
  slug: z.string(),
  icon: z.string(),
  enabledFor: enabledForSchema.default("all"),
});

const oAuthIntegrationAuthenticationSchema = z.object({
  type: z.literal("oauth"),
  scopes: z.array(z.string()),
  environments: z.record(z.object({ client_id: z.string() })),
});

const apiKeyIntegrationAuthenticationSchema = z.object({
  type: z.literal("api_key"),
  header_name: z.string(),
  header_type: z.union([z.literal("access_token"), z.literal("bearer")]),
  documentation: z.string(),
});

export type APIKeyAuthentication = z.infer<
  typeof apiKeyIntegrationAuthenticationSchema
>;

const integrationSchema = integrationMetadataSchema.extend({
  authentication: z.discriminatedUnion("type", [
    oAuthIntegrationAuthenticationSchema,
    apiKeyIntegrationAuthenticationSchema,
  ]),
});

const schema = z.array(integrationSchema);

type Catalog = z.infer<typeof schema>;
export type CatalogIntegration = Catalog[number];

export function getCatalog(raw: string, isAdmin: boolean) {
  const doc = parseDocument(raw);
  invariant(doc, `Catalog doc is not defined: ${raw}`);
  const jsObject = doc.toJS();
  const catalog = schema.parse(jsObject);

  return catalog.filter((i) => {
    switch (i.enabledFor) {
      case "all":
        return true;
      case "admins":
        return isAdmin;
      case "none":
        return false;
    }
  });
}
