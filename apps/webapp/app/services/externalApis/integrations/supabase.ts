import type { HelpSample, Integration } from "../types";

const usageSample: HelpSample = {
  title: "Using the client",
  code: `
  import { SupabaseManagement } from "@trigger.dev/supabase";

  const supabase = new SupabaseManagement({
    id: "__SLUG__",
  });
  
  new Job(client, {
    id: "on-new-users",
    name: "On New Users",
    version: "0.1.1",
    trigger: supabase.onChange({
      table: "users",
      events: ["INSERT"],
    }),
    run: async (payload, io, ctx) => {
    },
  });
  
  `,
};

export const supabase: Integration = {
  identifier: "supabase",
  name: "Supabase",
  packageName: "@trigger.dev/supabase",
  authenticationMethods: {
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
          usageSample,
        ],
      },
    },
  },
};
