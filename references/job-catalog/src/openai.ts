import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { OpenAI } from "@trigger.dev/openai";

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

createExpressServer(client);
