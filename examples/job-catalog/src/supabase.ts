import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createExpressServer } from "@trigger.dev/express";
import { z } from "zod";
import { SupabaseManagement } from "@trigger.dev/supabase";

const supabaseManagement = new SupabaseManagement({
  id: "supabase-management",
  apiKey: process.env["SUPABASE_API_KEY"]!,
});

const db = supabaseManagement.db(process.env["SUPABASE_ID"]!);

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

createExpressServer(client);

client.defineJob({
  id: "supabase-management-example-1",
  name: "Supabase Management Example 1",
  version: "0.1.0",
  trigger: db.onInserted({
    table: "users",
  }),
  run: async (payload, io, ctx) => {},
});

client.defineJob({
  id: "supabase-management-example-2",
  name: "Supabase Management Example 2",
  version: "0.1.0",
  trigger: db.onUpdated({
    table: "users",
  }),
  run: async (payload, io, ctx) => {},
});
