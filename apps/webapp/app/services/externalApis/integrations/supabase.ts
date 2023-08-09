import type { HelpSample, Integration } from "../types";

const managementUsageSample: HelpSample = {
  title: "Using the client",
  code: `
import { SupabaseManagement } from "@trigger.dev/supabase";

const supabase = new SupabaseManagement({
  id: "__SLUG__",
});

new Job(client, {
  id: "on-new-todos",
  name: "On New Todos",
  version: "0.1.1",
  trigger: supabase.onInserted({
    table: "todos",
  }),
  run: async (payload, io, ctx) => {
  },
});
  `,
};

const managementApiKeyUsageSample: HelpSample = {
  title: "Using the client",
  code: `
import { SupabaseManagement } from "@trigger.dev/supabase";

const supabase = new SupabaseManagement({
  id: "__SLUG__",
  apiKey: process.env.SUPABASE_API_KEY!,
});

new Job(client, {
  id: "on-new-todos",
  name: "On New Todos",
  version: "0.1.1",
  trigger: supabase.onInserted({
    table: "todos",
  }),
  run: async (payload, io, ctx) => {
  },
});
  `,
};

export const supabaseManagement: Integration = {
  identifier: "supabase-management",
  icon: "supabase",
  name: "Supabase Management",
  packageName: "@trigger.dev/supabase",
  description: "Use database webhooks, manage your organizations and projects.",
  authenticationMethods: {
    apikey: {
      type: "apikey",
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { SupabaseManagement } from "@trigger.dev/supabase";

const supabase = new SupabaseManagement({
  id: "__SLUG__"
  apiKey: process.env.SUPABASE_API_KEY!,
});
`,
          },
          managementApiKeyUsageSample,
        ],
      },
    },
    oauth2: {
      name: "OAuth",
      type: "oauth2",
      client: {
        id: {
          envName: "CLOUD_SUPABASE_CLIENT_ID",
        },
        secret: {
          envName: "CLOUD_SUPABASE_CLIENT_SECRET",
        },
      },
      config: {
        authorization: {
          url: "https://api.supabase.com/v1/oauth/authorize",
          scopeSeparator: " ",
        },
        token: {
          url: "https://api.supabase.com/v1/oauth/token",
          metadata: { accountPointer: "/team/name" },
          authorizationMethod: "body",
        },
        refresh: {
          url: "https://api.supabase.com/v1/oauth/token",
          skipScopes: true,
        },
      },
      scopes: [
        {
          name: "all",
          description:
            "Grants full access to all resources available in the Supabase Management API.",
          defaultChecked: true,
        },
      ],
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { SupabaseManagement } from "@trigger.dev/supabase";

const supabase = new SupabaseManagement({
  id: "__SLUG__"
});
`,
          },
          managementUsageSample,
        ],
      },
    },
  },
};

const supabaseUsageSample: HelpSample = {
  title: "Using the client",
  code: `
import { Supabase } from "@trigger.dev/supabase";
import { Database } from "@/supabase.types";

const supabase = new Supabase<Database>({
  id: "__SLUG__",
  projectId: process.env.SUPABASE_ID!,
  supabaseKey: process.env.SUPABASE_API_KEY!,
});

new Job(client, {
  id: "on-new-users",
  name: "On New Users",
  version: "0.1.1",
  trigger: eventTrigger({
    name: "foo.bar
  }),
  integrations: {
    supabase
  },
  run: async (payload, io, ctx) => {
    await io.supabase.runTask("get-users", async (db) => {
      return await db.from("users").select("*");
    });
  },
});
  `,
};

export const supabase: Integration = {
  identifier: "supabase",
  icon: "supabase",
  name: "Supabase",
  packageName: "@trigger.dev/supabase",
  authenticationMethods: {
    apikey: {
      type: "apikey",
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { Supabase } from "@trigger.dev/supabase";

const supabase = new Supabase({
  id: "__SLUG__"
  projectId: process.env.SUPABASE_ID!,
  supabaseKey: process.env.SUPABASE_KEY!,
});
`,
          },
        ],
      },
    },
  },
};
