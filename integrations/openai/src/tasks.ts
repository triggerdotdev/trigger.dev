import type { AuthenticatedTask } from "@trigger.dev/sdk";
import {
  CreateChatCompletionRequest,
  CreateCompletionRequest,
  OpenAIApi,
} from "openai";
import { OpenAIIntegrationAuth } from "./types";
import { redactString } from "@trigger.dev/sdk";

type OpenAIClientType = InstanceType<typeof OpenAIApi>;

export const createCompletion: AuthenticatedTask<
  OpenAIClientType,
  CreateCompletionRequest,
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

type CreateCompletionResponseData = Awaited<
  ReturnType<OpenAIClientType["createCompletion"]>
>["data"];

export const backgroundCreateCompletion: AuthenticatedTask<
  OpenAIClientType,
  CreateCompletionRequest,
  CreateCompletionResponseData,
  OpenAIIntegrationAuth
> = {
  run: async (params, client, task, io, auth) => {
    return io.backgroundFetch<CreateCompletionResponseData>(
      "background",
      "https://api.openai.com/v1/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: redactString`Bearer ${auth.apiKey}`,
          ...(auth.organization
            ? { "OpenAI-Organization": auth.organization }
            : {}),
        },
        body: JSON.stringify(params),
      }
    );
  },
  init: (params) => {
    return {
      name: "Background Completion",
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

type CreateChatCompetionResponseData = Awaited<
  ReturnType<OpenAIClientType["createChatCompletion"]>
>["data"];

export const createChatCompletion: AuthenticatedTask<
  OpenAIClientType,
  CreateChatCompletionRequest,
  CreateChatCompetionResponseData
> = {
  run: async (params, client) => {
    return client.createChatCompletion(params).then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Chat Completion",
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

export const backgroundCreateChatCompletion: AuthenticatedTask<
  OpenAIClientType,
  CreateChatCompletionRequest,
  CreateChatCompetionResponseData,
  OpenAIIntegrationAuth
> = {
  run: async (params, client, task, io, auth) => {
    return io.backgroundFetch<CreateChatCompetionResponseData>(
      "background",
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: redactString`Bearer ${auth.apiKey}`,
          ...(auth.organization
            ? { "OpenAI-Organization": auth.organization }
            : {}),
        },
        body: JSON.stringify(params),
      },
      {
        "500-599": {
          strategy: "backoff",
          limit: 5,
          minTimeoutInMs: 1000,
          maxTimeoutInMs: 30000,
          factor: 1.8,
          randomize: true,
        },
        "429": {
          strategy: "backoff",
          limit: 10,
          minTimeoutInMs: 1000,
          maxTimeoutInMs: 60000,
          factor: 2,
          randomize: true,
        },
      }
    );
  },
  init: (params) => {
    return {
      name: "Background Chat Completion",
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
