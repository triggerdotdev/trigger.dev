import type { Integration } from "../types";

export const typeform: Integration = {
  identifier: "typeform",
  name: "Typeform",
  description: "Use the Typeform API and trigger on new responses",
  packageName: "@trigger.dev/typeform@latest",
  authenticationMethods: {
    apikey: {
      type: "apikey",
      help: {
        samples: [
          {
            title: "Creating the client",
            code: `
import { Typeform } from "@trigger.dev/typeform";

const typeform = new Typeform({
  id: "__SLUG__",
  apiKey: process.env.TYPEFORM_TOKEN!,
});
`,
          },
          {
            title: "Using the client",
            code: `
client.defineJob({
  id: "typeform-response",
  name: "Typeform Response",
  version: "0.0.1",
  trigger: typeform.onFormResponse({
    uid: "<form uid>",
    tag: "<webhook tag>",
  }),
  integrations: {
    typeform,
  },
  run: async (payload, io, ctx) => {
    await io.typeform.getForm(payload.form_response.form_id);
  },
});
            `,
            highlight: [
              [5, 8],
              [9, 11],
              [13, 13],
            ],
          },
        ],
      },
    },
  },
};
