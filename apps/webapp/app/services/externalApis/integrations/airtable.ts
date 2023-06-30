import type { Integration } from "../types";

export const airtable: Integration = {
  identifier: "airtable",
  name: "Airtable",
  packageName: "@trigger.dev/airtable",
  authenticationMethods: {
    oauth2: {
      name: "OAuth2",
      type: "oauth2",
      client: {
        id: {
          envName: "CLOUD_AIRTABLE_CLIENT_ID",
        },
        secret: {
          envName: "CLOUD_AIRTABLE_CLIENT_SECRET",
        },
      },
      config: {
        authorization: {
          url: "https://airtable.com/oauth2/v1/authorize",
          scopeSeparator: " ",
          authorizationLocation: "header",
          extraParameters: {
            response_type: "code",
          },
        },
        token: {
          url: "https://airtable.com/oauth2/v1/token",
          metadata: {},
        },
        refresh: {
          url: "https://airtable.com/oauth2/v1/token",
        },
      },
      scopes: [
        {
          name: "data.records:read",
          description: "See the data in records",
          defaultChecked: true,
        },
        {
          name: "data.records:write",
          description: "Create, edit, and delete records",
          defaultChecked: true,
        },
        {
          name: "data.recordComments:read",
          description: "See comments in records",
          defaultChecked: true,
        },
        {
          name: "data.recordComments:write",
          description: "Create, edit, and delete record comments",
          defaultChecked: true,
        },
        {
          name: "schema.bases:read",
          description:
            "See the structure of a base, like table names or field types",
        },
        {
          name: "schema.bases:write",
          description:
            "Edit the structure of a base, like adding new fields or tables",
        },
        {
          name: "webhook:manage",
          description:
            "View, create, delete webhooks for a base, as well as fetch webhook payloads.",
          defaultChecked: true,
        },
      ],
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { Airtable } from "@trigger.dev/airtable";

const airtable = new Airtable({
  id: "__SLUG__"
});
`,
          },
        ],
      },
    },
  },
};
