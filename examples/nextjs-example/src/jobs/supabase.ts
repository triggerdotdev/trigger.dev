import { client } from "@/trigger";
import { Job, eventTrigger } from "@trigger.dev/sdk";
import { SupabaseManagement } from "@trigger.dev/supabase";
import { z } from "zod";

const supabase = new SupabaseManagement({
  id: "supabase",
});

type UserRecord = {
  id: number;
  first_name: string;
  last_name: string;
  created_at: string;
  email_address: string;
};

new Job(client, {
  id: "supabase-playground",
  name: "Supabase Playground",
  version: "0.1.1",
  trigger: eventTrigger({
    name: "supabase.playground",
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {
    await io.supabase.getPGConfig("get-pg-config", {
      ref: payload.ref,
    });

    await io.supabase.getOrganizations("get-orgs");
    await io.supabase.getProjects("get-projects");

    await io.supabase.listFunctions("list-functions", {
      ref: payload.ref,
    });

    await io.supabase.runQuery("run-query", {
      ref: payload.ref,
      query: "SELECT * FROM users",
    });

    await io.supabase.getTypescriptTypes("get-typescript-types", {
      ref: payload.ref,
    });
  },
});

new Job(client, {
  id: "supabase-create-project",
  name: "Supabase Create Project",
  version: "0.1.1",
  trigger: eventTrigger({
    name: "supabase.create",
    schema: z.object({
      name: z.string(),
      organization_id: z.string(),
      plan: z.enum(["free", "pro"]),
      region: z.enum(["us-east-1", "us-west-1"]),
      password: z.string(),
    }),
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {
    await io.supabase.createProject("create-project", {
      name: payload.name,
      organization_id: payload.organization_id,
      plan: payload.plan,
      region: payload.region,
      kps_enabled: true,
      db_pass: payload.password,
    });
  },
});

new Job(client, {
  id: "supabase-on-user-insert",
  name: "Supabase On User Insert",
  version: "0.1.1",
  trigger: supabase.onInserted<UserRecord>({
    projectRef: "axtbanoixaztvdntngew",
    table: "users",
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {},
});

new Job(client, {
  id: "supabase-on-user-email-changed",
  name: "Supabase On User Email Changed",
  version: "0.1.1",
  trigger: supabase.onUpdated<UserRecord>({
    projectRef: "axtbanoixaztvdntngew",
    table: "users",
    columns: ["email_address"],
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {},
});

new Job(client, {
  id: "supabase-on-user-deleted",
  name: "Supabase On User Deleted",
  version: "0.1.1",
  trigger: supabase.onDeleted<UserRecord>({
    projectRef: "axtbanoixaztvdntngew",
    table: "users",
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {},
});
