import { Integration } from "../types";

export const vercel: Integration = {
  identifier: "vercel",
  name: "Vercel",
  packageName: "@trigger.dev/vercel@latest",
  authenticationMethods: {
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
          {
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
  },
});
          `,
            highlight: [[12, 15]],
          },
        ],
      },
    },
  },
};
