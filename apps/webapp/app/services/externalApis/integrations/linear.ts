import type { HelpSample, Integration } from "../types";

function usageSample(hasApiKey: boolean): HelpSample {
  return {
    title: "Using the client",
    code: `
import { Linear } from "@trigger.dev/linear";

const linear = new Linear({
  id: "__SLUG__",${hasApiKey ? ",\n  apiKey: process.env.LINEAR_API_KEY!" : ""}
});

client.defineJob({
  id: "linear-react-to-new-issue",
  name: "Linear - React To New Issue",
  version: "0.1.0",
  integrations: { linear },
  trigger: linear.onIssueCreated(),
  run: async (payload, io, ctx) => {
    await io.linear.createComment("create-comment", {
      issueId: payload.data.id,
      body: "Thank's for opening this issue!"
    });

    await io.linear.createReaction("create-reaction", {
      issueId: payload.data.id,
      emoji: "+1"
    });

    return { payload, ctx };
  },
});
  `,
  };
}

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
          name: "read",
          description: "Read access for the user's account. This scope must always be present.",
          defaultChecked: true,
        },
        {
          name: "write",
          description:
            "Grants global write access to the user's account. Use a more targeted scope if you don't need full access.",
          defaultChecked: true,
        },

        {
          name: "issues:create",
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
        samples: [usageSample(false)],
      },
    },
    apikey: {
      type: "apikey",
      help: {
        samples: [usageSample(true)],
      },
    },
  },
};
