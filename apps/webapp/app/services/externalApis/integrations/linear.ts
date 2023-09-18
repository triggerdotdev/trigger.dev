import type { HelpSample, Integration } from "../types";

const usageSample: HelpSample = {
  title: "Using the client",
  code: `
import { Linear, events } from "@trigger.dev/linear";

const linear = new Linear({
  id: "__SLUG__",
  token: process.env.LINEAR_TOKEN!,
});

client.defineJob({
  id: "linear-integration-on-issue-created",
  name: "Linear Integration - On Issue Created",
  version: "0.1.0",
  integrations: { linear },
  trigger: linear.onIssueCreated(),
  run: async (payload, io, ctx) => {
    await io.linear.doSomething("some-task", {
      foo: "bar"
    });

    await io.linear.doSomethingElse("some-other-task", {
      bar: "baz"
    });

    return { payload, ctx };
  },
});
  
  `,
};

export const linear: Integration = {
  identifier: "linear",
  name: "Linear",
  packageName: "@trigger.dev/linear@latest",
  authenticationMethods: {
    oauth2: {
      name: "OAuth",
      type: "oauth2",
      client: {
        id: {
          envName: "CLOUD_LINEAR_CLIENT_ID",
        },
        secret: {
          envName: "CLOUD_LINEAR_CLIENT_SECRET",
        },
      },
      config: {
        authorization: {
          url: "https://linear.app/oauth/authorize",
          scopeSeparator: ",",
        },
        token: {
          url: "https://api.linear.app/oauth/token",
          metadata: {},
        },
        refresh: {
          url: "https://linear.app/oauth/authorize",
        },
        pkce: false,
      },
      scopes: [
        {
          name: "write",
          description:
            "Grants global write access to the user's account. Use a more targeted scope if you don't need full access.",
          defaultChecked: true,
        },

        {
          name: "issue:create",
          description: "Grants access to create issues and attachments only.",
          annotations: [{ label: "Issues" }],
        },

        {
          name: "comments:create",
          description: "Grants access to create new issue comments.",
          annotations: [{ label: "Comments" }],
        },

        {
          name: "admin",
          description:
            "Grants full access to admin-level endpoints. Don't use this unless you really need it.",
        },
      ],
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { Linear } from "@trigger.dev/linear";

const linear = new Linear({
  id: "__SLUG__"
});
`,
          },
          usageSample,
        ],
      },
    },
    apikey: {
      type: "apikey",
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { Linear } from "@trigger.dev/linear";

const linear = new Linear({
  id: "__SLUG__",
  token: process.env.LINEAR_TOKEN!
});
`,
          },
          usageSample,
        ],
      },
    },
  },
};
