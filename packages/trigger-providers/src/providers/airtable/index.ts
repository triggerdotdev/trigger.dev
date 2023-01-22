export const airtable = {
  name: "Airtable",
  slug: "airtable",
  icon: "/integrations/airtable.png",
  enabledFor: "admins",
  authentication: {
    type: "oauth",
    scopes: [
      "data.records:read",
      "data.records:write",
      "data.recordComments:read",
      "data.recordComments:write",
      "schema.bases:read",
      "schema.bases:write",
      "webhook:manage",
    ],
  },
  schemas: {},
};
