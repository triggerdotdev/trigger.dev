import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger, invokeTrigger } from "@trigger.dev/sdk";
import { OpenAI } from "@trigger.dev/openai";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const openai = new OpenAI({
  id: "openai",
  apiKey: process.env["OPENAI_API_KEY"]!,
  defaultHeaders: { "user-agent": "trigger.dev job-catalog reference 1.0" },
});

client.defineJob({
  id: "openai-tasks",
  name: "OpenAI Tasks",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "openai.tasks",
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    const models = await io.openai.listModels("list-models");

    if (models.length > 0) {
      await io.openai.retrieveModel("get-model", {
        model: models[0].id,
      });
    }

    await io.openai.chat.completions.backgroundCreate("background-chat-completion", {
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: "Create a good programming joke about background jobs",
        },
      ],
    });

    await io.openai.chat.completions.create("chat-completion", {
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: "Create a good programming joke about background jobs",
        },
      ],
    });

    await io.openai.completions.backgroundCreate("background-completion", {
      model: "text-davinci-003",
      prompt: "Create a good programming joke about Tasks",
    });

    await io.openai.completions.create("completion", {
      model: "text-davinci-003",
      prompt: "Create a good programming joke about Tasks",
    });

    await io.openai.createEdit("edit", {
      model: "text-davinci-edit-001",
      input: "Thsi is ridddled with erors",
      instruction: "Fix the spelling errors",
    });

    await io.openai.createEmbedding("embedding", {
      model: "text-embedding-ada-002",
      input: "The food was delicious and the waiter...",
    });
  },
});

client.defineJob({
  id: "openai-gpt-4-turbo",
  name: "OpenAI GPT 4 Turbo",
  version: "0.0.1",
  trigger: invokeTrigger(),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    await io.openai.chat.completions.create("background-chat-completion", {
      model: "gpt-4-1106-preview",
      messages: [
        {
          role: "user",
          content:
            "Create a good programming joke about background jobs, including something about Trigger.dev",
        },
      ],
    });
  },
});

client.defineJob({
  id: "openai-dalle-3",
  name: "OpenAI Dalle 3",
  version: "0.0.1",
  trigger: invokeTrigger(),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    await io.openai.images.create("dalle-3", {
      model: "dall-e-3",
      prompt:
        "I would like to generate an image of an american boy riding a bycicle in a suburban neighborhood, into the sunset.",
    });

    await io.openai.images.backgroundCreate("dalle-3-background", {
      model: "dall-e-3",
      prompt:
        "Create a comic strip featuring miles morales and spiderpunk fighting off the sinister six",
    });
  },
});

client.defineJob({
  id: "openai-background-completion",
  name: "OpenAI Background Completion",
  version: "0.0.1",
  trigger: invokeTrigger(),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    await io.openai.chat.completions.backgroundCreate("completion 1", {
      model: "gpt-4",
      messages: [
        {
          role: "user",
          content: "What is the difference between green threads and native threads in Python?",
        },
      ],
    });
  },
});

client.defineJob({
  id: "openai-rate-limit-handling",
  name: "OpenAI GPT Rate Limits",
  version: "0.0.1",
  trigger: invokeTrigger(),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    await io.openai.chat.completions.backgroundCreate("completion 1", {
      model: "gpt-4-1106-preview",
      messages: [
        {
          role: "user",
          content:
            'I want you to act as a debater. I will provide you with some topics related to current events and your task is to research both sides of the debates, present valid arguments for each side, refute opposing points of view, and draw persuasive conclusions based on evidence. Your goal is to help people come away from the discussion with increased knowledge and insight into the topic at hand. My first request is "I want an opinion piece about Deno."',
        },
      ],
    });

    await io.openai.chat.completions.backgroundCreate("completion 2", {
      model: "gpt-4-1106-preview",
      messages: [
        {
          role: "user",
          content:
            'I want you to act as a movie critic. You will develop an engaging and creative movie review. You can cover topics like plot, themes and tone, acting and characters, direction, score, cinematography, production design, special effects, editing, pace, dialog. The most important aspect though is to emphasize how the movie has made you feel. What has really resonated with you. You can also be critical about the movie. Please avoid spoilers. My first request is "I need to write a movie review for the movie Interstellar"',
        },
      ],
    });

    await io.openai.chat.completions.backgroundCreate(
      "completion 3",
      {
        model: "gpt-4-1106-preview",
        messages: [
          {
            role: "user",
            content: ` want you to act as a motivational speaker. Put together words that inspire action and make people feel empowered to do something beyond their abilities. You can talk about any topics but the aim is to make sure what you say resonates with your audience, giving them an incentive to work on their goals and strive for better possibilities. My first request is "I need a speech about how everyone should never give up."`,
          },
        ],
      },
      {},
      { timeout: { durationInMs: 30000, retry: { limit: 1 } } }
    );
  },
});

client.defineJob({
  id: "openai-create-assistant",
  name: "OpenAI GPT Create Assistant",
  version: "0.0.1",
  trigger: invokeTrigger({
    schema: z.object({
      model: z.string().default("gpt-4-1106-preview"),
    }),
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    const file = await io.openai.files.createAndWaitForProcessing("upload-file", {
      purpose: "assistants",
      file: fs.createReadStream("./fixtures/mydata.csv"),
    });

    const assistant = await io.openai.beta.assistants.create("create-assistant", {
      name: "Data visualizer",
      description:
        "You are great at creating beautiful data visualizations. You analyze data present in .csv files, understand trends, and come up with data visualizations relevant to those trends. You also share a brief text summary of the trends observed.",
      model: payload.model,
      tools: [{ type: "code_interpreter" }],
      file_ids: [file.id],
    });

    // Really we would want to save the assistant id somewhere

    return { assistant, file };
  },
});

client.defineJob({
  id: "openai-manage-assistant",
  name: "OpenAI GPT Manage Assistant",
  version: "0.0.1",
  trigger: invokeTrigger({
    schema: z.object({
      assistantId: z.string().optional(),
    }),
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    const assistants = await io.openai.beta.assistants.list("list", {
      limit: 10,
    });

    if (payload.assistantId) {
      await io.openai.beta.assistants.retrieve("retrieve", payload.assistantId);
      await io.openai.beta.assistants.update("update", payload.assistantId, {
        name: "Updated name",
      });
      await io.openai.beta.assistants.del("delete", payload.assistantId);
    }

    for (const assistant of assistants) {
      await io.openai.beta.assistants.del(`delete ${assistant.id}`, assistant.id);
    }
  },
});

client.defineJob({
  id: "openai-use-assistant",
  name: "OpenAI GPT Use Assistant",
  version: "0.0.1",
  trigger: invokeTrigger({
    schema: z.object({
      id: z.string(),
      fileId: z.string(),
    }),
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    const run = await io.openai.beta.threads.createAndRunUntilCompletion("create-thread", {
      assistant_id: payload.id,
      thread: {
        messages: [
          {
            role: "user",
            content: "Create 3 data visualizations based on the trends in this file.",
            file_ids: [payload.fileId],
          },
        ],
      },
    });

    if (run.status !== "completed") {
      throw new Error(`Run finished with status ${run.status}: ${JSON.stringify(run.last_error)}`);
    }

    const messages = await io.openai.beta.threads.messages.list("list-messages", run.thread_id);

    const reversedMessages = [...messages].reverse();

    await io.runTask(
      "log-messages",
      async (task) => {
        for (const message of reversedMessages) {
          switch (message.role) {
            case "user": {
              for (const content of message.content) {
                switch (content.type) {
                  case "text": {
                    await io.logger.info(`Assistant: ${content.text.value}`);

                    break;
                  }
                  case "image_file": {
                    const file = await io.openai.files.retrieve(
                      ["file", content.image_file.file_id],
                      content.image_file.file_id
                    );

                    const fileContent = await io.openai.native.files.retrieveContent(
                      content.image_file.file_id
                    );

                    const filePath = `tmp/${file.filename}`;

                    // Use fsPromises to write the file to disk at tmp/file.fileName
                    await fsPromises.writeFile(filePath, fileContent);

                    await io.logger.info(
                      `Assistant: retrieved file ${content.image_file.file_id} at ${filePath}`
                    );
                  }
                }
              }

              break;
            }
            case "assistant": {
              for (const content of message.content) {
                switch (content.type) {
                  case "text": {
                    await io.logger.info(`Assistant: ${content.text.value}`);

                    break;
                  }
                  case "image_file": {
                    const file = await io.openai.files.retrieve(
                      ["file", content.image_file.file_id],
                      content.image_file.file_id
                    );

                    const fileContent = await io.openai.native.files.retrieveContent(
                      content.image_file.file_id
                    );

                    const filePath = `tmp/${file.filename}`;

                    // Use fsPromises to write the file to disk at tmp/file.fileName
                    await fsPromises.writeFile(filePath, fileContent);

                    await io.logger.info(
                      `Assistant: retrieved file ${content.image_file.file_id} at ${filePath}`
                    );
                  }
                }
              }

              break;
            }
          }
        }
      },
      {
        name: "Log messages",
        icon: "openai",
      }
    );

    return run;
  },
});

client.defineJob({
  id: "openai-vision",
  name: "OpenAI GPT 4 Vision",
  version: "0.0.1",
  trigger: invokeTrigger({
    schema: z.object({
      image: z.string(),
      prompt: z.string().default("What’s in this image?"),
      detail: z.enum(["low", "high", "auto"]).default("auto"),
    }),
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    const response = await io.openai.chat.completions.create("📺", {
      model: "gpt-4-vision-preview",
      max_tokens: 300,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: payload.prompt },
            {
              type: "image_url",
              image_url: {
                url: payload.image,
                detail: payload.detail,
              },
            },
          ],
        },
      ],
    });
  },
});

const perplexity = new OpenAI({
  id: "perplexity",
  apiKey: process.env["PERPLEXITY_API_KEY"]!,
  baseURL: "https://api.perplexity.ai",
  icon: "brand-open-source",
});

client.defineJob({
  id: "perplexity-tasks",
  name: "Perplexity Tasks",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "perplexity.tasks",
  }),
  integrations: {
    perplexity,
  },
  run: async (payload, io, ctx) => {
    await io.perplexity.chat.completions.create("chat-completion", {
      model: "mistral-7b-instruct",
      messages: [
        {
          role: "user",
          content: "Create a good programming joke about background jobs",
        },
      ],
    });

    await io.perplexity.chat.completions.backgroundCreate("background-chat-completion", {
      model: "mistral-7b-instruct",
      messages: [
        {
          role: "user",
          content: "If you were a programming language, what would you be and why?",
        },
      ],
    });
  },
});

const azureOpenAI = new OpenAI({
  id: "azure-openai",
  apiKey: process.env["AZURE_API_KEY"]!,
  icon: "brand-azure",
  baseURL: "https://my-resource.openai.azure.com/openai/deployments/my-gpt35-16k-deployment",
  defaultQuery: { "api-version": "2023-06-01-preview" },
  defaultHeaders: { "api-key": process.env["AZURE_API_KEY"] },
});

client.defineJob({
  id: "azure-tasks",
  name: "azure Tasks",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "azure.tasks",
  }),
  integrations: {
    azureOpenAI,
  },
  run: async (payload, io, ctx) => {
    await io.azureOpenAI.chat.completions.create(
      "chat-completion",
      {
        model: "my-gpt35-16k-deployment",
        messages: [
          {
            role: "user",
            content: "Create a good programming joke about background jobs",
          },
        ],
      },
      {
        headers: {
          "User-Agent": "Trigger.dev",
        },
      }
    );

    await io.azureOpenAI.chat.completions.backgroundCreate("background-chat-completion", {
      model: "my-gpt35-16k-deployment",
      messages: [
        {
          role: "user",
          content: "If you were a programming language, what would you be and why?",
        },
      ],
    });
  },
});

client.defineJob({
  id: "openai-files",
  name: "OpenAI Files",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "openai.files",
  }),
  integrations: {
    openai,
  },
  run: async (payload, io, ctx) => {
    const fileAsString = await io.openai.files.createAndWaitForProcessing("upload-file-as-string", {
      purpose: "assistants",
      file: "This is a string",
    });

    const fileAsFetch = await io.openai.files.createAndWaitForProcessing("upload-file-as-fetch", {
      purpose: "assistants",
      file: await fetch("https://trigger.dev"),
    });

    await io.openai.images.edit("dalle-2", {
      model: "dall-e-2",
      image:
        "https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/497142eb-7a51-4262-de1c-da75917cb000/public",
      prompt: "Can you make this image look like a painting?",
      response_format: "url",
    });
  },
});

createExpressServer(client);
