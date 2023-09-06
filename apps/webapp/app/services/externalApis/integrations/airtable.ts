import type { HelpSample, Integration } from "../types";

function usageSample(hasApiKey: boolean): HelpSample {
  return {
    title: "Using the client",
    code: `
import { Airtable } from "@trigger.dev/airtable";

const airtable = new Airtable({
  id: "__SLUG__"${hasApiKey ? ",\n  token: process.env.AIRTABLE_TOKEN!" : ""}
});

//you can define your Airtable table types
type LaunchGoalsAndOkRs = {
  "Launch goals"?: string;
  DRI?: Collaborator;
  Team?: string;
  Status?: "On track" | "In progress" | "At risk";
  "Key results"?: Array<string>;
  "Features (from 💻 Features table)"?: Array<string>;
  "Status (from 💻 Features)": Array<"Live" | "Complete" | "In progress" | "Planning" | "In reviews">;
};

client.defineJob({
  id: "airtable-example-1",
  name: "Airtable Example 1: getRecords",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "airtable.example",
    schema: z.object({
      baseId: z.string(),
      tableName: z.string(),
    }),
  }),
  integrations: {
    airtable,
  },
  run: async (payload, io, ctx) => {
    //then you can set the types for your table, so you get type safety
    const table = io.airtable.base(payload.baseId).table<LaunchGoalsAndOkRs>(payload.tableName);

    const records = await table.getRecords("muliple records", { fields: ["Status"] });
    //this will be type checked
    await io.logger.log(records[0].fields.Status ?? "no status");
  },
});
  `,
  };
}

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
          description: "See the structure of a base, like table names or field types",
        },
        {
          name: "schema.bases:write",
          description: "Edit the structure of a base, like adding new fields or tables",
        },
        {
          name: "webhook:manage",
          description:
            "View, create, delete webhooks for a base, as well as fetch webhook payloads.",
          defaultChecked: true,
        },
      ],
      help: {
        samples: [usageSample(false)],
      },
    },
    apiKey: {
      type: "apikey",
      help: {
        samples: [usageSample(true)],
      },
    },
  },
};
