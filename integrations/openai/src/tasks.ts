import type { AuthenticatedTask } from "@trigger.dev/sdk";
import { CreateChatCompletionRequest, OpenAIApi } from "openai";

type OpenAIClientType = InstanceType<typeof OpenAIApi>;

export const createCompletion: AuthenticatedTask<
  OpenAIClientType,
  {
    model: string;
    prompt: string | string[];
    suffix?: string;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    n?: number;
    logprobs?: number;
    echo?: boolean;
    stop?: string | string[];
    presence_penalty?: number;
    frequency_penalty?: number;
    best_of?: number;
    user?: string;
  },
  Awaited<ReturnType<OpenAIClientType["createCompletion"]>>["data"]
> = {
  run: async (params, client) => {
    return client.createCompletion(params).then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Completion",
      params,
      icon: "openai",
      properties: [
        {
          label: "model",
          text: params.model,
        },
      ],
    };
  },
};

export const createChatCompletion: AuthenticatedTask<
  OpenAIClientType,
  CreateChatCompletionRequest,
  Awaited<ReturnType<OpenAIClientType["createChatCompletion"]>>["data"]
> = {
  run: async (params, client) => {
    return client.createChatCompletion(params).then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Completion",
      params,
      icon: "openai",
      properties: [
        {
          label: "model",
          text: params.model,
        },
      ],
    };
  },
};
