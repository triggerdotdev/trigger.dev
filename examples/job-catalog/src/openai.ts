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

const functions = [
  {
    "name": "get_current_affairs",
    "description": "Get the current affairs from google",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "query to search for google result",
        }
      },
      "required": ["query"],
    },
  }
]

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'function';
  content: string;
  name?: string;
  function_call?: () => void
};

const chatMessages: ChatMessage[] = [
  {
    role: "user",
    content: "who won fifa world cup 2022 with some related links to read more about it",
  }
]

const get_current_affairs = async (query: string) => {
  //Call to google search api
  // const results = await fetch(`https://www.googleapis.com/customsearch/v1?${query}`);
  return 'Argentina national football team'
}

const available_functions: Record<string, (query: string) => Promise<string>> = {
  get_current_affairs: get_current_affairs,
};

const openai = new OpenAI({
  id: "openai",
  apiKey: process.env["OPENAI_API_KEY"]!,
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

    await io.openai.backgroundCreateChatCompletion("background-chat-completion", {
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "user",
          content: "Create a good programming joke about background jobs",
        },
      ],
    });

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

    await io.openai.createEmbedding("embedding", {
      model: "text-embedding-ada-002",
      input: "The food was delicious and the waiter...",
    });

    //Function call example for OpenAI
    //Send the conversation and available functions to GPT
    const createCompletion = async () => {
      const chatCompletion = await io.openai.createChatCompletion("chat-completion", {
        model: "gpt-3.5-turbo",
        messages: chatMessages,
        functions,
        function_call: "auto"
      });
      return chatCompletion
    }

    const chatCompletion = await createCompletion();
    // This response will contain JSON which contains function name and args 
    // that you can use to call the function in your code.
    const response = chatCompletion?.choices[0].message;

    if ('function_call' in response) {
      const function_name: string = "get_current_affairs";
      const function_call = available_functions[function_name];
      //Get arguments from GPT response
      const args = JSON.parse(response['function_call']?.['arguments'] || '{}');

      //Call the function in our code using the arguments from openAI
      const fn_response = await function_call(...Object.values(args) as [string]);

      // Extend conversation with function result & Get new response from GPT 
      chatMessages.push({
        role: 'function',
        name: function_name,
        content: fn_response
      })
      const finalCompletion = await createCompletion();

      //This will contain the final result
      await io.logger.info(finalCompletion?.choices[0].message.content?.toString() || '');
    }
  },
});

createExpressServer(client);
