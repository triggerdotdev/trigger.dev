import { client } from "@/trigger";
import { OpenAI } from "@trigger.dev/openai";
import { Job, eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

const openai = new OpenAI({
  id: "openai",
  apiKey: process.env.OPENAI_API_KEY!,
});

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
    await io.openai.listModels("list-models");

    await io.openai.backgroundCreateChatCompletion(
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

    await io.openai.createChatCompletion("chat-completion", {
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: "Create a good programming joke about background jobs",
        },
      ],
    });

    await io.openai.backgroundCreateCompletion("background-completion", {
      model: "text-davinci-003",
      prompt: "Create a good programming joke about Tasks",
    });

    await io.openai.createCompletion("completion", {
      model: "text-davinci-003",
      prompt: "Create a good programming joke about Tasks",
    });
  },
});

new Job(client, {
  id: "openai-files",
  name: "OpenAI Files",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "openai.files",
    schema: z.object({}),
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    // jsonl string
    await io.openai.createFile("file-string", {
      file: `{ "prompt": "Tell me a joke", "completion": "Something funny" }\n{ "prompt": "Tell me another joke", "completion": "Something also funny" }`,
      fileName: "cool-file.jsonl",
      purpose: "fine-tune",
    });

    // fine tune file
    await io.openai.createFineTuneFile("file-fine-tune", {
      fileName: "fine-tune.jsonl",
      examples: [
        {
          prompt: "Tell me a joke",
          completion: "Why did the chicken cross the road? No one knows",
        },
        {
          prompt: "Tell me another joke",
          completion:
            "Why did the chicken cross the road? To get to the other side",
        },
      ],
    });

    const files = await io.openai.listFiles("list-files");
    await io.logger.info("files", files);
  },
});
