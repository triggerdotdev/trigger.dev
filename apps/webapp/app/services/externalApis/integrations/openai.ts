import type { Integration } from "../types";

export const openai: Integration = {
  identifier: "openai",
  name: "OpenAI",
  description: "You can perform very long completions with the integration",
  packageName: "@trigger.dev/openai",
  authenticationMethods: {
    apikey: {
      type: "apikey",
      help: {
        samples: [],
      },
    },
  },
};
