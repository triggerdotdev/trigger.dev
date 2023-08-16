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

const airtable = new Airtable({
  id: "airtable",
  token: process.env["AIRTABLE_TOKEN"],
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

type BaseType = {
  customers: LaunchGoalsAndOkRs;
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
    const records1 = io.airtable.tasks
      ?.base(payload.baseId)
      .table<LaunchGoalsAndOkRs>(payload.tableName)
      .getRecords("whatever", {}, io);

    const records = await io.airtable
      .base<BaseType>(payload.baseId)
      .table("customers")
      .getRecords("whatever", {
        where: {
          createdAt: {
            lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
          },
        },
      });
  },
});

// 1. Type-level: Update IOWithIntegrations to just infer io.airtable to be the same type as integrations.airtable
// 2. Inject the io and the auth into the integration when calling io.airtable
// 3. Airtable integration will need to call io.runTask
// 4. All other integrations will need updating

createExpressServer(client);
