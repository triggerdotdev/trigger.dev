import { TriggerClient } from "@trigger.dev/sdk";
import { createExpressServer } from "@trigger.dev/express";
import { Supabase, SupabaseManagement } from "@trigger.dev/supabase";
import { Database } from "./supabase-types";

const supabaseManagement = new SupabaseManagement({
  id: "supabase-management",
  apiKey: process.env["SUPABASE_API_KEY"]!,
});

const triggers = supabaseManagement.db<Database>(process.env["SUPABASE_ID"]!);

const supabase = new Supabase({
  id: "supabase",
  supabaseKey: process.env["SUPABASE_SERVICE_ROLE_KEY"]!,
  supabaseUrl: process.env["SUPABASE_URL"]!,
});

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
  trigger: triggers.onInserted({
    table: "todos",
  }),
  run: async (payload, io, ctx) => {},
});

client.defineJob({
  id: "supabase-management-example-2",
  name: "Supabase Management Example 2",
  version: "0.1.0",
  trigger: triggers.onUpdated({
    table: "todos",
  }),
  run: async (payload, io, ctx) => {},
});

client.defineJob({
  id: "supabase-management-example-users-auth",
  name: "Supabase Management Example Users Auth",
  version: "0.1.0",
  trigger: triggers.onInserted({
    table: "users",
    schema: "auth",
  }),
  run: async (payload, io, ctx) => {},
});

client.defineJob({
  id: "supabase-management-example-objects-storage",
  name: "Supabase Management Example Object Storage",
  version: "0.1.0",
  trigger: triggers.onInserted({
    schema: "storage",
    table: "objects",
    filter: {
      record: {
        bucket_id: ["example_bucket"],
        name: [
          {
            $endsWith: ".png",
          },
        ],
        path_tokens: [
          {
            $includes: "images",
          },
        ],
      },
    },
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {
    const { signedUrl } = await io.supabase.runTask("create-signed-url", async (db) => {
      if (!payload.record.name) {
        throw new Error("Missing record name");
      }

      const { data, error } = await db.storage
        .from("example_bucket")
        .createSignedUrl(payload.record.name, 60);

      if (error) {
        throw error;
      }

      return data;
    });
  },
});

client.defineJob({
  id: "supabase-management-example-on",
  name: "Supabase Management Example On",
  version: "0.1.0",
  trigger: triggers.on({
    table: "todos",
    events: ["INSERT", "UPDATE"],
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {
    const user = await io.supabase.runTask("fetch-user", async (db) => {
      const { data, error } = await db.auth.admin.getUserById(payload.record.user_id);

      if (error) {
        throw error;
      }

      return data.user;
    });

    return user;
  },
});
