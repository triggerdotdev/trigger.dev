import type { AuthenticatedTask } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIIntegrationAuth } from "./types";
import { redactString } from "@trigger.dev/sdk";
import { Prettify, fileFromString, fileFromUrl, truncate } from "@trigger.dev/integration-kit";
import { createTaskUsageProperties, onTaskError } from "./taskUtils";

type OpenAIClientType = InstanceType<typeof OpenAI>;

export const retrieveModel: AuthenticatedTask<
  OpenAIClientType,
  { model: string },
  OpenAI.Models.Model
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return await client.models.retrieve(params.model);
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

export const listModels: AuthenticatedTask<OpenAIClientType, void, OpenAI.Models.Model[]> = {
  onError: onTaskError,
  run: async (params, client) => {
    const response = await client.models.list();

    return response.data;
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
  Prettify<OpenAI.CompletionCreateParamsNonStreaming>,
  OpenAI.Completion
> = {
  run: async (params, client, task) => {
    const response = await client.completions.create(params);

    task.outputProperties = createTaskUsageProperties(response.usage);

    return response;
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

export const backgroundCreateCompletion: AuthenticatedTask<
  OpenAIClientType,
  Prettify<OpenAI.CompletionCreateParamsNonStreaming>,
  Prettify<OpenAI.Completion>,
  OpenAIIntegrationAuth
> = {
  run: async (params, client, task, io, auth) => {
    const response = await io.backgroundFetch<OpenAI.Completion>(
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

export const createChatCompletion: AuthenticatedTask<
  OpenAIClientType,
  Prettify<OpenAI.Chat.CompletionCreateParamsNonStreaming>,
  Prettify<OpenAI.Chat.ChatCompletion>
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const response = await client.chat.completions.create(params);

    task.outputProperties = createTaskUsageProperties(response.usage);

    return response;
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
  Prettify<OpenAI.Chat.CompletionCreateParamsNonStreaming>,
  Prettify<OpenAI.Chat.ChatCompletion>,
  OpenAIIntegrationAuth
> = {
  run: async (params, client, task, io, auth) => {
    const response = await io.backgroundFetch<OpenAI.Chat.ChatCompletion>(
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

/**
 * @deprecated The Edits API is deprecated; please use Chat Completions instead.
 */
export const createEdit: AuthenticatedTask<
  OpenAIClientType,
  Prettify<OpenAI.EditCreateParams>,
  OpenAI.Edit
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const response = await client.edits.create(params);

    task.outputProperties = createTaskUsageProperties(response.usage);

    return response;
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

export const generateImage: AuthenticatedTask<
  OpenAIClientType,
  Prettify<OpenAI.Images.ImageGenerateParams>,
  OpenAI.Images.ImagesResponse
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const response = await client.images.generate(params);

    return response;
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

export const createImage = generateImage;

export type CreateImageEditRequest = {
  image: string | File;
  prompt: string;
  mask?: string | File;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024";
  response_format?: "url" | "b64_json";
  user?: string;
};

export const createImageEdit: AuthenticatedTask<
  OpenAIClientType,
  Prettify<CreateImageEditRequest>,
  OpenAI.Images.ImagesResponse
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const file = typeof params.image === "string" ? await fileFromUrl(params.image) : params.image;
    const mask = typeof params.mask === "string" ? await fileFromUrl(params.mask) : params.mask;

    const response = await client.images.edit({
      image: file,
      prompt: params.prompt,
      mask: mask,
      n: params.n,
      size: params.size,
      response_format: params.response_format,
      user: params.user,
    });

    return response;
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
  OpenAI.Images.ImagesResponse
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const file = typeof params.image === "string" ? await fileFromUrl(params.image) : params.image;

    const response = await client.images.createVariation({
      image: file,
      n: params.n,
      size: params.size,
      response_format: params.response_format,
      user: params.user,
    });

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

export const createEmbedding: AuthenticatedTask<
  OpenAIClientType,
  Prettify<OpenAI.EmbeddingCreateParams>,
  OpenAI.Embeddings.CreateEmbeddingResponse
> = {
  onError: onTaskError,
  run: async (params, client, task) => {
    const response = await client.embeddings.create(params);

    task.outputProperties = createTaskUsageProperties(response.usage);

    return response;
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
      ],
    };
  },
};

type CreateFileRequest = {
  file: string | File;
  fileName?: string;
  purpose: string;
};

export const createFile: AuthenticatedTask<
  OpenAIClientType,
  Prettify<CreateFileRequest>,
  Prettify<OpenAI.Files.FileObject>
> = {
  onError: onTaskError,
  run: async (params, client) => {
    let file: File;

    if (typeof params.file === "string") {
      file = await fileFromString(params.file, params.fileName ?? "file.txt");
    } else {
      file = params.file;
    }

    return client.files.create({ file, purpose: params.purpose });
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

export const listFiles: AuthenticatedTask<OpenAIClientType, void, OpenAI.Files.FileObject[]> = {
  onError: onTaskError,
  run: async (params, client) => {
    const response = await client.files.list();

    return response.data;
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
  Prettify<OpenAI.Files.FileObject>
> = {
  onError: onTaskError,
  run: async (params, client) => {
    const file = await fileFromString(
      params.examples.map((d) => JSON.stringify(d)).join("\n"),
      params.fileName
    );

    return client.files.create({ file, purpose: "fine-tune" });
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

export const createFineTune: AuthenticatedTask<
  OpenAIClientType,
  Prettify<OpenAI.FineTuneCreateParams>,
  OpenAI.FineTunes.FineTune
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.fineTunes.create(params);
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

export const listFineTunes: AuthenticatedTask<OpenAIClientType, void, OpenAI.FineTunes.FineTune[]> =
  {
    onError: onTaskError,
    run: async (params, client) => {
      const response = await client.fineTunes.list();

      return response.data;
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

export const retrieveFineTune: AuthenticatedTask<
  OpenAIClientType,
  Prettify<SpecificFineTuneRequest>,
  OpenAI.FineTunes.FineTune
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.fineTunes.retrieve(params.fineTuneId);
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

export const cancelFineTune: AuthenticatedTask<
  OpenAIClientType,
  Prettify<SpecificFineTuneRequest>,
  OpenAI.FineTunes.FineTune
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.fineTunes.cancel(params.fineTuneId);
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

export const listFineTuneEvents: AuthenticatedTask<
  OpenAIClientType,
  Prettify<SpecificFineTuneRequest>,
  OpenAI.FineTuneEventsListResponse
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.fineTunes.listEvents(params.fineTuneId, { stream: false });
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

export const deleteFineTune: AuthenticatedTask<
  OpenAIClientType,
  Prettify<DeleteFineTunedModelRequest>,
  OpenAI.Models.ModelDeleted
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.models.del(params.fineTunedModelId);
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

/**
 * Creates a job that fine-tunes a specified model from a given dataset.
 *
 * Response includes details of the enqueued job including job status and the name
 * of the fine-tuned models once complete.
 *
 * [Learn more about fine-tuning](https://platform.openai.com/docs/guides/fine-tuning)
 */
export const createFineTuningJob: AuthenticatedTask<
  OpenAIClientType,
  Prettify<OpenAI.FineTuning.JobCreateParams>,
  OpenAI.FineTuning.FineTuningJob
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.fineTuning.jobs.create(params);
  },
  init: (params) => {
    let properties = [
      {
        label: "File ID",
        text: params.training_file,
      },
    ];

    if (params.model) {
      properties.push({
        label: "Model",
        text: params.model,
      });
    }

    if (params.validation_file) {
      properties.push({
        label: "Validation file",
        text: params.validation_file,
      });
    }

    return {
      name: "Create Fine Tuning Job",
      params,
      icon: "openai",
      properties,
    };
  },
};

/**
 * Get info about a fine-tuning job.
 *
 * [Learn more about fine-tuning](https://platform.openai.com/docs/guides/fine-tuning)
 */
export const retrieveFineTuningJob: AuthenticatedTask<
  OpenAIClientType,
  { id: string },
  OpenAI.FineTuning.FineTuningJob
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.fineTuning.jobs.retrieve(params.id);
  },
  init: (params) => {
    return {
      name: "Retrieve Fine Tuning Job",
      params,
      icon: "openai",
      properties: [
        {
          label: "Job ID",
          text: params.id,
        },
      ],
    };
  },
};

export const cancelFineTuningJob: AuthenticatedTask<
  OpenAIClientType,
  { id: string },
  OpenAI.FineTuning.FineTuningJob
> = {
  onError: onTaskError,
  run: async (params, client) => {
    return client.fineTuning.jobs.cancel(params.id);
  },
  init: (params) => {
    return {
      name: "Cancel Fine Tuning Job",
      params,
      icon: "openai",
      properties: [
        {
          label: "Job ID",
          text: params.id,
        },
      ],
    };
  },
};

export const listFineTuningJobEvents: AuthenticatedTask<
  OpenAIClientType,
  { id: string },
  OpenAI.FineTuning.FineTuningJobEvent[]
> = {
  onError: onTaskError,
  run: async (params, client) => {
    const response = await client.fineTuning.jobs.listEvents(params.id);

    return response.data;
  },
  init: (params) => {
    return {
      name: "List Fine Tuning Job Events",
      params,
      icon: "openai",
      properties: [
        {
          label: "Job ID",
          text: params.id,
        },
      ],
    };
  },
};

/**
 * List your organization's fine-tuning jobs
 */
export const listFineTuningJobs: AuthenticatedTask<
  OpenAIClientType,
  OpenAI.FineTuning.JobListParams,
  OpenAI.FineTuning.FineTuningJob[]
> = {
  onError: onTaskError,
  run: async (params, client) => {
    const response = await client.fineTuning.jobs.list(params);

    return response.data;
  },
  init: (params) => {
    return {
      name: "List Fine Tuning Jobs",
      params,
      icon: "openai",
      properties: [],
    };
  },
};
