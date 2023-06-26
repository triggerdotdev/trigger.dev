import { highlight } from "prismjs";
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
        samples: [
          {
            title: "Creating the client",
            code: `
import { OpenAI } from "@trigger.dev/openai";

const openai = new OpenAI({
  id: "openai",
  apiKey: process.env.OPENAI_API_KEY!,
});
`,
          },
          {
            title: "Using the client",
            code: `
new Job(client, {
  id: "openai-tasks",
  name: "OpenAI Tasks",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "openai.tasks",
    schema: z.object({}),
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    //this background function can take longer than a serverless timeout
    const response = await io.openai.backgroundCreateChatCompletion(
      "background-chat-completion",
      {
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "user",
            content: "Create a good programming joke about background jobs",
          },
        ],
      }
    );

    await io.logger.info("choices", response.choices);
  },
});
            `,
            highlight: [
              [10, 10],
              [13, 24],
            ],
          },
        ],
      },
    },
  },
};
