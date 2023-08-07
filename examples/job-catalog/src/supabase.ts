import { TriggerClient } from "@trigger.dev/sdk";
import { createExpressServer } from "@trigger.dev/express";
import { Supabase, SupabaseManagement } from "@trigger.dev/supabase";

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

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export interface Database {
  public: {
    Tables: {
      todos: {
        Row: {
          id: number;
          inserted_at: string;
          is_complete: boolean | null;
          task: string | null;
          user_id: string;
        };
        Insert: {
          id?: number;
          inserted_at?: string;
          is_complete?: boolean | null;
          task?: string | null;
          user_id: string;
        };
        Update: {
          id?: number;
          inserted_at?: string;
          is_complete?: boolean | null;
          task?: string | null;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "todos_user_id_fkey";
            columns: ["user_id"];
            referencedRelation: "users";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      [_ in never]: never;
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
}
