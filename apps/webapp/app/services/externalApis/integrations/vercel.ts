import { HelpSample, Integration } from "../types";

const usageSample: HelpSample = {
  title: "Using the client",
  code: `
import { Vercel } from "@trigger.dev/vercel";

const vercel = new Vercel({
  id: "__SLUG__",
  token: process.env.VERCEL_API_TOKEN!
});

client.defineJob({
  id: "vercel-deployment-created-proj",
  name: "Vercel Deployment Created (Project)",
  version: "0.1.0",
  trigger: vercel.onDeploymentCreated({
    teamId: "team_kTDbLdHFZ0x7HU66LRgZCfqh",
    projectIds: ["prj_vt57HZEY7iilPaJv71LcOVLcEiPs"],
  }),
  run: async (payload, io, ctx) => {
    io.logger.info("deployment created event received");
    io.logger.info(JSON.stringify(payload));
  },
});
`,
};

export const vercel: Integration = {
  identifier: "vercel",
  name: "Vercel",
  packageName: "@trigger.dev/vercel@latest",
  authenticationMethods: {
    oauth2: {
      name: "OAuth",
      type: "oauth2",
      client: {
        id: {
          envName: "CLOUD_VERCEL_CLIENT_ID",
        },
        secret: {
          envName: "CLOUD_VERCEL_CLIENT_SECRET",
        },
      },
      config: {
        authorization: {
          url: "https://vercel.com/integrations/trigger-dev-hmacr-test/new",
          scopeSeparator: " ", // dummy since no scopes
        },
        token: {
          url: "https://api.vercel.com/v2/oauth/access_token",
          metadata: {},
        },
        refresh: {
          url: "", // no refresh token for Vercel
        },
      },
      scopes: [], // no scopes
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { Vercel } from "@trigger.dev/vercel";

const vercel = new Vercel({
	id: "__SLUG__",
});
`,
          },
          usageSample,
        ],
      },
    },
    apiKey: {
      type: "apikey",
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { Vercel } from "@trigger.dev/vercel";

const vercel = new Vercel({
  id: "__SLUG__",
  token: process.env.VERCEL_API_TOKEN!
});
`,
          },
          usageSample,
        ],
      },
    },
  },
};
