import { eventTrigger } from "@trigger.dev/sdk";
import { client } from "../trigger";
import { OpenAI } from "@trigger.dev/openai";

const openai = new OpenAI({
  id: "openai",
  apiKey: process.env["OPENAI_API_KEY"]!,
});

// use Open AI to summarize text from the form
client.defineJob({
  id: "react-hook",
  name: "React Hook test",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "react-hook",
  }),
  integrations: {
    openai,
  },
  run: async (_payload, io) => {
    await io.wait("Wait 2 seconds", 2);
    await io.wait("Wait 1 second", 1);

    const result = await io.openai.backgroundCreateChatCompletion("Tell me a joke", {
      model: "gpt-3.5-turbo-16k",
      messages: [
        {
          role: "user",
          content: `Tell me a joke please`,
        },
      ],
    });

    return {
      summary: result?.choices[0]?.message?.content,
    };
  },
});
