import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createExpressServer } from "@trigger.dev/express";
import { z } from "zod";
import { Airtable, Collaborator } from "@trigger.dev/airtable";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

// const airtable = new Airtable({
//   id: "airtable",
//   token: process.env["AIRTABLE_TOKEN"],
// });

const airtable = new Airtable({
  id: "airtable-oauth",
});

type Status = "Live" | "Complete" | "In progress" | "Planning" | "In reviews";

type LaunchGoalsAndOkRs = {
  "Launch goals"?: string;
  DRI?: Collaborator;
  Team?: string;
  Status?: "On track" | "In progress" | "At risk";
  "Key results"?: Array<string>;
  "Features (from 💻 Features table)"?: Array<string>;
  "Status (from 💻 Features)": Array<Status>;
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
    const table = io.airtable.base(payload.baseId).table<LaunchGoalsAndOkRs>(payload.tableName);

    const records = await table.getRecords("muliple records", { fields: ["Status"] });
    await io.logger.log(records[0].fields.Status ?? "no status");

    const aRecord = await table.getRecord("single", records[0].id);

    const newRecords = await table.createRecords("create records", [
      {
        fields: { "Launch goals": "Created from Trigger.dev", Status: "In progress" },
      },
    ]);

    const updatedRecords = await table.updateRecords(
      "update records",
      newRecords.map((record) => ({
        id: record.id,
        fields: { Status: "At risk" },
      }))
    );

    await io.wait("5 secs", 5);

    const deletedRecords = await table.deleteRecords(
      "delete records",
      updatedRecords.map((record) => record.id)
    );
  },
});

//todo webhooks require batch support
// client.defineJob({
//   id: "airtable-delete-webhooks",
//   name: "Airtable Example 2: webhook admin",
//   version: "0.1.0",
//   trigger: eventTrigger({
//     name: "airtable.example",
//     schema: z.object({
//       baseId: z.string(),
//       deleteWebhooks: z.boolean().optional(),
//     }),
//   }),
//   integrations: {
//     airtable,
//   },
//   run: async (payload, io, ctx) => {
//     const webhooks = await io.airtable.webhooks().list("list webhooks", { baseId: payload.baseId });

//     if (payload.deleteWebhooks === true) {
//       for (const webhook of webhooks.webhooks) {
//         await io.airtable.webhooks().delete(`delete webhook: ${webhook.id}`, {
//           baseId: payload.baseId,
//           webhookId: webhook.id,
//         });
//       }
//     }
//   },
// });

//todo changes the structure of the trigger so it's airtable.base("val").onChanges({
// client.defineJob({
//   id: "airtable-on-table",
//   name: "Airtable Example: onTable",
//   version: "0.1.0",
//   trigger: airtable.onTableChanges({
//     baseId: "appSX6ly4nZGfdUSy",
//     tableId: "tblr5BReu2yeOMk7n",
//   }),
//   run: async (payload, io, ctx) => {
//     await io.logger.log(`transaction number ${payload.baseTransactionNumber}`);
//   },
// });

createExpressServer(client);
