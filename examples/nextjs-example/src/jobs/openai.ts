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
    const models = await io.openai.listModels("list-models");

    await io.openai.retrieveModel("get-model", {
      model: models[0].id,
    });

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

    await io.openai.createEdit("edit", {
      model: "text-davinci-edit-001",
      input: "Thsi is ridddled with erors",
      instruction: "Fix the spelling errors",
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
    const fineTuneFile = await io.openai.createFineTuneFile("file-fine-tune", {
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

    const model = await io.openai.createFineTune("fine-tune", {
      model: "davinci",
      training_file: fineTuneFile.id,
    });

    const fineTunes = await io.openai.listFineTunes("list-fine-tunes");

    const fineTune = await io.openai.retrieveFineTune("get-fine-tune", {
      fineTuneId: model.id,
    });

    const events = await io.openai.listFineTuneEvents("list-fine-tune-events", {
      fineTuneId: model.id,
    });

    const cancelFineTune = await io.openai.cancelFineTune("cancel-fine-tune", {
      fineTuneId: model.id,
    });

    const files = await io.openai.listFiles("list-files");
    await io.logger.info("files", files);

    //this will fail because the fine tune didn't complete
    await io.logger.info(
      "This next task will fail because the model never completed"
    );
    const deleteFineTune = await io.openai.deleteFineTune("delete-fine-tune", {
      fineTunedModelId: model.id,
    });
  },
});
