import type { AuthenticatedTask } from "@trigger.dev/sdk";
import {
  CreateChatCompletionRequest,
  CreateCompletionRequest,
  CreateEditRequest,
  CreateEmbeddingRequest,
  CreateFineTuneRequest,
  CreateImageRequest,
  OpenAIApi,
} from "openai";
import { OpenAIIntegrationAuth } from "./types";
import { redactString } from "@trigger.dev/sdk";
import { Prettify, fileFromString, fileFromUrl, truncate } from "@trigger.dev/integration-kit";
import { createTaskUsageProperties, onTaskError } from "./taskUtils";

type OpenAIClientType = InstanceType<typeof OpenAIApi>;

type RetrieveModelRequest = {
  model: string;
};

type RetrieveModelResponseData = Prettify<
  Awaited<ReturnType<OpenAIClientType["retrieveModel"]>>["data"]
>;

export const retrieveModel: AuthenticatedTask<
  OpenAIClientType,
  Prettify<RetrieveModelRequest>,
  RetrieveModelResponseData
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.retrieveModel(params.model).then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Retrieve model",
      params,
      icon: "openai",
      properties: [
        {
          label: "Model id",
          text: params.model,
        },
      ],
    };
  },
};

type ListModelsResponseData = Awaited<ReturnType<OpenAIClientType["listModels"]>>["data"];

export const listModels: AuthenticatedTask<
  OpenAIClientType,
  void,
  Prettify<ListModelsResponseData>
> = {
  onError: onTaskError,
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

export const createCompletion: AuthenticatedTask<
  OpenAIClientType,
  Prettify<CreateCompletionRequest>,
  Prettify<Awaited<ReturnType<OpenAIClientType["createCompletion"]>>["data"]>
> = {
  run: async (params, client, task) => {
    const response = await client.createCompletion(params);

    task.outputProperties = createTaskUsageProperties(response.data.usage);

    return response.data;
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
  Prettify<CreateCompletionRequest>,
  Prettify<CreateCompletionResponseData>,
  OpenAIIntegrationAuth
> = {
  run: async (params, client, task, io, auth) => {
    const response = await io.backgroundFetch<CreateCompletionResponseData>(
      "background",
      "https://api.openai.com/v1/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: redactString`Bearer ${auth.apiKey}`,
          ...(auth.organization ? { "OpenAI-Organization": auth.organization } : {}),
        },
        body: JSON.stringify(params),
      }
    );

    task.outputProperties = createTaskUsageProperties(response.usage);

    return response;
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
  Prettify<CreateChatCompletionRequest>,
  Prettify<CreateChatCompetionResponseData>
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const response = await client.createChatCompletion(params);

    task.outputProperties = createTaskUsageProperties(response.data.usage);

    return response.data;
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
  Prettify<CreateChatCompletionRequest>,
  Prettify<CreateChatCompetionResponseData>,
  OpenAIIntegrationAuth
> = {
  run: async (params, client, task, io, auth) => {
    const response = await io.backgroundFetch<CreateChatCompetionResponseData>(
      "background",
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: redactString`Bearer ${auth.apiKey}`,
          ...(auth.organization ? { "OpenAI-Organization": auth.organization } : {}),
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

    task.outputProperties = createTaskUsageProperties(response.usage);

    return response;
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

type CreateEditResponseData = Prettify<Awaited<ReturnType<OpenAIClientType["createEdit"]>>["data"]>;

export const createEdit: AuthenticatedTask<
  OpenAIClientType,
  Prettify<CreateEditRequest>,
  CreateEditResponseData
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const response = await client.createEdit(params);

    task.outputProperties = createTaskUsageProperties(response.data.usage);

    return response.data;
  },
  init: (params) => {
    let properties = [
      {
        label: "Model",
        text: params.model,
      },
    ];

    if (params.input) {
      properties.push({
        label: "Input",
        text: truncate(params.input, 40),
      });
    }

    properties.push({
      label: "Instruction",
      text: truncate(params.instruction, 40),
    });

    return {
      name: "Create edit",
      params,
      icon: "openai",
      properties,
    };
  },
};

type CreateImageResponseData = Prettify<
  Awaited<ReturnType<OpenAIClientType["createImage"]>>["data"]
>;

export const createImage: AuthenticatedTask<
  OpenAIClientType,
  Prettify<CreateImageRequest>,
  CreateImageResponseData
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const response = await client.createImage(params);

    return response.data;
  },
  init: (params) => {
    let properties = [
      {
        label: "Prompt",
        text: params.prompt,
      },
    ];

    if (params.n) {
      properties.push({
        label: "Number of images",
        text: params.n.toString(),
      });
    }

    if (params.size) {
      properties.push({
        label: "Size",
        text: params.size,
      });
    }

    if (params.response_format) {
      properties.push({
        label: "Response format",
        text: params.response_format,
      });
    }

    return {
      name: "Create image",
      params,
      icon: "openai",
      properties,
    };
  },
};

export type CreateImageEditRequest = {
  image: string | File;
  prompt: string;
  mask?: string | File;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024";
  response_format?: "url" | "b64_json";
  user?: string;
};

type CreateImageEditResponseData = Prettify<
  Awaited<ReturnType<OpenAIClientType["createImageEdit"]>>["data"]
>;

export const createImageEdit: AuthenticatedTask<
  OpenAIClientType,
  Prettify<CreateImageEditRequest>,
  CreateImageEditResponseData
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const file = typeof params.image === "string" ? await fileFromUrl(params.image) : params.image;
    const mask = typeof params.mask === "string" ? await fileFromUrl(params.mask) : params.mask;

    const response = await client.createImageEdit(
      file,
      params.prompt,
      mask,
      params.n,
      params.size,
      params.response_format,
      params.user
    );

    return response.data;
  },
  init: (params) => {
    let properties = [];

    properties.push({
      label: "Prompt",
      text: params.prompt,
    });

    if (params.n) {
      properties.push({
        label: "Number of images",
        text: params.n.toString(),
      });
    }

    if (params.size) {
      properties.push({
        label: "Size",
        text: params.size,
      });
    }

    if (params.response_format) {
      properties.push({
        label: "Response format",
        text: params.response_format,
      });
    }

    if (typeof params.image === "string") {
      properties.push({
        label: "Image URL",
        text: params.image,
        url: params.image,
      });
    }

    return {
      name: "Create image edit",
      params,
      icon: "openai",
      properties,
    };
  },
};

type CreateImageVariationResponseData = Prettify<
  Awaited<ReturnType<OpenAIClientType["createImageVariation"]>>["data"]
>;

export type CreateImageVariationRequest = {
  image: string | File;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024";
  response_format?: "url" | "b64_json";
  user?: string;
};

export const createImageVariation: AuthenticatedTask<
  OpenAIClientType,
  Prettify<CreateImageVariationRequest>,
  CreateImageVariationResponseData
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const file = typeof params.image === "string" ? await fileFromUrl(params.image) : params.image;

    const response = await client
      .createImageVariation(file, params.n, params.size, params.response_format, params.user)
      .then((res) => res.data);

    return response;
  },
  init: (params) => {
    let properties = [];

    if (params.n) {
      properties.push({
        label: "Number of images",
        text: params.n.toString(),
      });
    }

    if (params.size) {
      properties.push({
        label: "Size",
        text: params.size,
      });
    }

    if (params.response_format) {
      properties.push({
        label: "Response format",
        text: params.response_format,
      });
    }

    if (typeof params.image === "string") {
      properties.push({
        label: "Image URL",
        text: params.image,
        url: params.image,
      });
    }

    return {
      name: "Create image variation",
      params,
      icon: "openai",
      properties,
    };
  },
};

type CreateEmbeddingResponseData = Prettify<
  Awaited<ReturnType<OpenAIClientType["createEmbedding"]>>["data"]
>;

export const createEmbedding: AuthenticatedTask<
  OpenAIClientType,
  Prettify<CreateEmbeddingRequest>,
  CreateEmbeddingResponseData
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const response = await client.createEmbedding(params);

    task.outputProperties = createTaskUsageProperties(response.data.usage);

    return response.data;
  },
  init: (params) => {
    return {
      name: "Create embedding",
      params,
      icon: "openai",
      properties: [
        {
          label: "Model",
          text: params.model,
        },
        {
          label: "Input",
          text:
            typeof params.input === "string"
              ? truncate(params.input, 40)
              : truncate(params.input.at(0) ?? "none", 40),
        },
      ],
    };
  },
};

type CreateFileResponseData = Awaited<ReturnType<OpenAIClientType["createFile"]>>["data"];

type CreateFileRequest = {
  file: string | File;
  fileName?: string;
  purpose: string;
};

export const createFile: AuthenticatedTask<
  OpenAIClientType,
  Prettify<CreateFileRequest>,
  Prettify<CreateFileResponseData>
> = {
  onError: onTaskError,
  run: async (params, client) => {
    let file: File;

    if (typeof params.file === "string") {
      file = await fileFromString(params.file, params.fileName ?? "file.txt");
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

type ListFilesResponseData = Prettify<Awaited<ReturnType<OpenAIClientType["listFiles"]>>["data"]>;

export const listFiles: AuthenticatedTask<OpenAIClientType, void, ListFilesResponseData> = {
  onError: onTaskError,
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
  Prettify<CreateFineTuneFileRequest>,
  Prettify<CreateFileResponseData>
> = {
  onError: onTaskError,
  run: async (params, client) => {
    const file = await fileFromString(
      params.examples.map((d) => JSON.stringify(d)).join("\n"),
      params.fileName
    );

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

type CreateFineTuneResponseData = Prettify<
  Awaited<ReturnType<OpenAIClientType["createFineTune"]>>["data"]
>;

export const createFineTune: AuthenticatedTask<
  OpenAIClientType,
  Prettify<CreateFineTuneRequest>,
  CreateFineTuneResponseData
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.createFineTune(params).then((res) => res.data);
  },
  init: (params) => {
    let properties = [
      {
        label: "Training file",
        text: params.training_file,
      },
    ];

    if (params.validation_file) {
      properties.push({
        label: "Validation file",
        text: params.validation_file,
      });
    }

    if (params.model) {
      properties.push({
        label: "Model",
        text: params.model,
      });
    }

    return {
      name: "Create fine tune",
      params,
      icon: "openai",
      properties,
    };
  },
};

type ListFineTunesResponseData = Prettify<
  Awaited<ReturnType<OpenAIClientType["listFineTunes"]>>["data"]
>;

export const listFineTunes: AuthenticatedTask<OpenAIClientType, void, ListFineTunesResponseData> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.listFineTunes().then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "List fine tunes",
      params,
      icon: "openai",
      properties: [],
    };
  },
};

type SpecificFineTuneRequest = {
  fineTuneId: string;
};

type RetrieveFineTuneResponseData = Prettify<
  Awaited<ReturnType<OpenAIClientType["retrieveFineTune"]>>["data"]
>;

export const retrieveFineTune: AuthenticatedTask<
  OpenAIClientType,
  Prettify<SpecificFineTuneRequest>,
  RetrieveFineTuneResponseData
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.retrieveFineTune(params.fineTuneId).then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Retrieve fine tune",
      params,
      icon: "openai",
      properties: [
        {
          label: "Fine tune id",
          text: params.fineTuneId,
        },
      ],
    };
  },
};

type CancelFineTuneResponseData = Prettify<
  Awaited<ReturnType<OpenAIClientType["cancelFineTune"]>>["data"]
>;

export const cancelFineTune: AuthenticatedTask<
  OpenAIClientType,
  Prettify<SpecificFineTuneRequest>,
  CancelFineTuneResponseData
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.cancelFineTune(params.fineTuneId).then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Cancel fine tune",
      params,
      icon: "openai",
      properties: [
        {
          label: "Fine tune id",
          text: params.fineTuneId,
        },
      ],
    };
  },
};

type ListFineTuneEventsResponseData = Prettify<
  Awaited<ReturnType<OpenAIClientType["listFineTuneEvents"]>>["data"]
>;

export const listFineTuneEvents: AuthenticatedTask<
  OpenAIClientType,
  Prettify<SpecificFineTuneRequest>,
  ListFineTuneEventsResponseData
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.listFineTuneEvents(params.fineTuneId, false).then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "List fine tune events",
      params,
      icon: "openai",
      properties: [
        {
          label: "Fine tune id",
          text: params.fineTuneId,
        },
      ],
    };
  },
};

type DeleteFineTunedModelRequest = {
  fineTunedModelId: string;
};

type DeleteFineTuneResponseData = Prettify<
  Awaited<ReturnType<OpenAIClientType["deleteModel"]>>["data"]
>;

export const deleteFineTune: AuthenticatedTask<
  OpenAIClientType,
  Prettify<DeleteFineTunedModelRequest>,
  DeleteFineTuneResponseData
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.deleteModel(params.fineTunedModelId).then((res) => res.data);
  },
  init: (params) => {
    return {
      name: "Delete fine tune model",
      params,
      icon: "openai",
      properties: [
        {
          label: "Fine tuned model id",
          text: params.fineTunedModelId,
        },
      ],
    };
  },
};
