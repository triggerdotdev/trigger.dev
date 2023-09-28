import type { HelpSample, Integration } from "../types";

function usageSample(hasApiKey: boolean): HelpSample {
  const apiKeyPropertyName = "apiKey";

  return {
    title: "Using the client",
    code: `
import { Replicate } from "@trigger.dev/replicate";

const replicate = new Replicate({
  id: "__SLUG__",${hasApiKey ? `,\n  ${apiKeyPropertyName}: process.env.REPLICATE_API_KEY!` : ""}
});

client.defineJob({
  id: "replicate-create-prediction",
  name: "Replicate - Create Prediction",
  version: "0.1.0",
  integrations: { replicate },
  trigger: eventTrigger({
    name: "replicate.predict",
    schema: z.object({
      prompt: z.string(),
      version: z.string(),
    }),
  }),
  run: async (payload, io, ctx) => {
    return io.replicate.predictions.createAndAwait("await-prediction", {
      version: payload.version,
      input: { prompt: payload.prompt },
    });
  },
});
  `,
  };
}

export const replicate: Integration = {
  identifier: "replicate",
  name: "Replicate",
  packageName: "@trigger.dev/replicate@latest",
  authenticationMethods: {
    apikey: {
      type: "apikey",
      help: {
        samples: [usageSample(true)],
      },
    },
  },
};
