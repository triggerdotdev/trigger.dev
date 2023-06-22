import type { AuthenticatedTask } from "@trigger.dev/sdk";
import {
  CreateChatCompletionRequest,
  CreateCompletionRequest,
  OpenAIApi,
} from "openai";
import { OpenAIIntegrationAuth } from "./types";
import { redactString } from "@trigger.dev/sdk";
import { fileFromString } from "@trigger.dev/integration-kit";

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

type ListModelsResponseData = Awaited<
  ReturnType<OpenAIClientType["listModels"]>
>["data"];

export const listModels: AuthenticatedTask<
  OpenAIClientType,
  void,
  ListModelsResponseData
> = {
  run: async (params, client) => {
    return client.listModels().then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "List models",
      params,
      icon: "openai",
      properties: [],
    };
  },
};

type CreateFileResponseData = Awaited<
  ReturnType<OpenAIClientType["createFile"]>
>["data"];

type CreateFileRequest = {
  file: string | File;
  fileName?: string;
  purpose: string;
};

export const createFile: AuthenticatedTask<
  OpenAIClientType,
  CreateFileRequest,
  CreateFileResponseData
> = {
  run: async (params, client) => {
    let file: File;

    if (typeof params.file === "string") {
      file = (await fileFromString(
        params.file,
        params.fileName ?? "file.txt"
      )) as any;
    } else {
      file = params.file;
    }

    return client.createFile(file, params.purpose).then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Create file",
      params,
      icon: "openai",
      properties: [
        {
          label: "Purpose",
          text: params.purpose,
        },
        {
          label: "Input type",
          text: typeof params.file === "string" ? "string" : "File",
        },
      ],
    };
  },
};

type ListFilesResponseData = Awaited<
  ReturnType<OpenAIClientType["listFiles"]>
>["data"];

export const listFiles: AuthenticatedTask<
  OpenAIClientType,
  void,
  ListFilesResponseData
> = {
  run: async (params, client) => {
    return client.listFiles().then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "List files",
      params,
      icon: "openai",
      properties: [],
    };
  },
};

type CreateFineTuneFileRequest = {
  fileName: string;
  examples: {
    prompt: string;
    completion: string;
  }[];
};

export const createFineTuneFile: AuthenticatedTask<
  OpenAIClientType,
  CreateFineTuneFileRequest,
  CreateFileResponseData
> = {
  run: async (params, client) => {
    const file = (await fileFromString(
      params.examples.map((d) => JSON.stringify(d)).join("\n"),
      params.fileName
    )) as any;

    return client.createFile(file, "fine-tune").then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Create fine tune file",
      params,
      icon: "openai",
      properties: [
        {
          label: "Examples",
          text: params.examples.length.toString(),
        },
      ],
    };
  },
};
