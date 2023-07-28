import { Database } from "@/supabase.types";
import { client } from "@/trigger";
import {
  type IntegrationIO,
  Job,
  eventTrigger,
  type JobPayload,
  type JobIO,
  type TriggerPayload,
  type IOWithIntegrations,
} from "@trigger.dev/sdk";
import { SupabaseManagement, Supabase } from "@trigger.dev/supabase";
import { z } from "zod";

const supabase = new SupabaseManagement({
  id: "supabase",
});

const db = supabase.db<Database>(process.env.SUPABASE_ID!);

const dbNoTypes = supabase.db(process.env.SUPABASE_ID!);

const supabaseManagementKey = new SupabaseManagement({
  id: "supabase-management-key",
  apiKey: process.env.SUPABASE_API_KEY!,
});

const dbKey = supabase.db<Database>(process.env.SUPABASE_ID!);

const supabaseDB = new Supabase<Database>({
  id: "supabase-db",
  supabaseUrl: `https://${process.env.SUPABASE_ID}.supabase.co`,
  supabaseKey: process.env.SUPABASE_KEY!,
});

async function doPlaygroundStuff(
  io: IntegrationIO<typeof supabaseManagementKey>,
  ref: string
) {
  await io.getPGConfig("get-pg-config", {
    ref,
  });
}

new Job(client, {
  id: "supabase-playground",
  name: "Supabase Playground",
  version: "0.1.1",
  trigger: eventTrigger({
    name: "supabase.playground",
  }),
  integrations: {
    supabase,
    supabaseDB,
    supabaseManagementKey,
  },
  run: async (payload, io, ctx) => {
    await io.supabaseManagementKey.getPGConfig("get-pg-config", {
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

    const users = await io.supabaseDB.runTask(
      "fetch-users",
      async (db) => {
        const { data, error } = await db.from("users").select("*");

        if (error) throw error;

        return data;
      },
      { name: "Fetch Users" }
    );

    const newUser = await io.supabaseDB.runTask(
      "create-user",
      async (db) => {
        return await db
          .from("users")
          .insert({
            first_name: "John",
            last_name: "Doe",
            email_address: "john@trigger.dev",
          })
          .select();
      },
      { name: "New Users" }
    );
  },
});

const createTodoJob = new Job(client, {
  id: "supabase-create-todo",
  name: "Supabase Create Todo",
  version: "0.1.1",
  trigger: eventTrigger({
    name: "supabase.create-todo",
    schema: z.object({
      contents: z.string(),
      user_id: z.number(),
    }),
  }),
  integrations: {
    supabaseDB,
  },
  run: async (payload, io, ctx) => {
    const newTodo = await io.supabaseDB.runTask(
      "create-todo",
      async (db) => {
        const { data, error } = await db
          .from("todos")
          .insert({
            contents: payload.contents,
            user_id: payload.user_id,
            is_complete: false,
          })
          .select();

        if (error) throw error;

        return data;
      },
      {
        name: "Create Todo",
        properties: [{ label: "Contents", text: payload.contents }],
      }
    );
  },
});

type CreateTodo = JobPayload<typeof createTodoJob>;
type CreateTodoIO = JobIO<typeof createTodoJob>;

async function runCreateTodo(payload: CreateTodo, io: CreateTodoIO) {
  const newTodo = await io.supabaseDB.runTask(
    "create-todo",
    async (db) => {
      const { data, error } = await db
        .from("todos")
        .insert({
          contents: payload.contents,
          user_id: payload.user_id,
          is_complete: false,
        })
        .select();

      if (error) throw error;

      return data;
    },
    {
      name: "Create Todo",
      properties: [{ label: "Contents", text: payload.contents }],
    }
  );
}

const createProjectTrigger = eventTrigger({
  name: "supabase.create",
  schema: z.object({
    name: z.string(),
    organization_id: z.string(),
    plan: z.enum(["free", "pro"]),
    region: z.enum(["us-east-1", "us-west-1"]),
    password: z.string(),
  }),
});

async function doRun(
  payload: TriggerPayload<typeof createProjectTrigger>,
  io: IOWithIntegrations<{ supabase: typeof supabase }>
) {
  await io.supabase.createProject("create-project", {
    name: payload.name,
    organization_id: payload.organization_id,
    plan: payload.plan,
    region: payload.region,
    kps_enabled: true,
    db_pass: payload.password,
  });
}

new Job(client, {
  id: "supabase-create-project",
  name: "Supabase Create Project",
  version: "0.1.1",
  trigger: createProjectTrigger,
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
  trigger: db.onInserted({
    table: "users",
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {},
});

new Job(client, {
  id: "supabase-on-user-insert-2",
  name: "Supabase On User Insert 2",
  version: "0.1.1",
  trigger: db.onInserted({
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
  trigger: db.onUpdated({
    table: "users",
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
  trigger: db.onDeleted({
    table: "users",
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {},
});

new Job(client, {
  id: "supabase-on-todo-created",
  name: "Supabase On TODO created",
  version: "0.1.1",
  trigger: dbKey.onInserted({
    table: "todos",
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {},
});

new Job(client, {
  id: "supabase-on-todo-created",
  name: "Supabase On TODO created",
  version: "0.1.1",
  trigger: dbKey.onInserted({
    table: "todos",
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {},
});

new Job(client, {
  id: "supabase-on-todo-completed",
  name: "Supabase On TODO completed",
  version: "0.1.1",
  trigger: dbKey.onUpdated({
    table: "todos",
    filter: {
      old_record: {
        is_complete: [false],
      },
      record: {
        is_complete: [true],
      },
    },
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {
    await io.logger.log("Todo Completed", { payload });
  },
});

new Job(client, {
  id: "supabase-on-tweet-created-or-deleted",
  name: "Supabase On Tweet Created or Deleted",
  version: "0.1.1",
  trigger: dbKey.onDeleted({
    schema: "public_2",
    table: "tweets",
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {},
});

new Job(client, {
  id: "supabase-on-todo-created-no-types",
  name: "Supabase On TODO created",
  version: "0.1.1",
  trigger: dbNoTypes.onInserted({
    table: "todos",
  }),
  integrations: {
    supabase,
  },
  run: async (payload, io, ctx) => {},
});
