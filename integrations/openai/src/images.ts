import { FetchRetryOptions, FetchTimeoutOptions } from "@trigger.dev/integration-kit";
import { IntegrationTaskKey, Prettify } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import { OpenAIIntegrationOptions, OpenAIRequestOptions } from "./types";
import {
  backgroundTaskRetries,
  createBackgroundFetchHeaders,
  createBackgroundFetchUrl,
  createImageTaskOutputProperties,
  createTaskOutputProperties,
  handleOpenAIError,
} from "./taskUtils";
import { Uploadable } from "openai/uploads";

export type CreateImageEditRequest = {
  image: string | File | Uploadable;
  prompt: string;
  mask?: string | File | Uploadable;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024";
  response_format?: "url" | "b64_json";
  user?: string;
  model?: (string & {}) | "dall-e-2" | null;
};

export type CreateImageVariationRequest = {
  image: string | File | Uploadable;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024";
  response_format?: "url" | "b64_json";
  user?: string;
  model?: (string & {}) | "dall-e-2" | null;
};

export class Images {
  constructor(
    private runTask: OpenAIRunTask,
    private options: OpenAIIntegrationOptions
  ) {}

  generate(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.Images.ImageGenerateParams>,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Images.ImagesResponse> {
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

    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.images
          .generate(params, { idempotencyKey: task.idempotencyKey, ...options })
          .withResponse();

        task.outputProperties = createImageTaskOutputProperties(data, response.headers);

        return data;
      },
      {
        name: "Create image",
        params,
        properties,
      },
      handleOpenAIError
    );
  }

  backgroundGenerate(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.Images.ImageGenerateParams>,
    options: OpenAIRequestOptions = {},
    fetchOptions: { retries?: FetchRetryOptions; timeout?: FetchTimeoutOptions } = {}
  ): Promise<OpenAI.Images.ImagesResponse> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const url = createBackgroundFetchUrl(
          client,
          "/images/generations",
          this.options.defaultQuery,
          options
        );

        const response = await io.backgroundFetchResponse<OpenAI.Images.ImagesResponse>(
          "background",
          url,
          {
            method: options.method ?? "POST",
            headers: createBackgroundFetchHeaders(
              client,
              task.idempotencyKey,
              this.options.defaultHeaders,
              options
            ),
            body: JSON.stringify(params),
          },
          {
            retry: fetchOptions?.retries ?? backgroundTaskRetries,
            timeout: fetchOptions?.timeout,
          }
        );

        task.outputProperties = createImageTaskOutputProperties(
          response.data,
          new Headers(response.headers)
        );

        return response.data;
      },
      {
        name: "Background Image Generate",
        params,
        properties: [
          {
            label: "model",
            text: params.model ?? "unknown",
          },
        ],
        retry: {
          limit: 0,
        },
      }
    );
  }

  create(...args: Parameters<Images["generate"]>) {
    return this.generate(...args);
  }

  backgroundCreate(...args: Parameters<Images["backgroundGenerate"]>) {
    return this.backgroundGenerate(...args);
  }

  edit(
    key: IntegrationTaskKey,
    params: CreateImageEditRequest,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Images.ImagesResponse> {
    let properties = [];

    properties.push({
      label: "Prompt",
      text: params.prompt,
    });

    if (typeof params.model === "string") {
      properties.push({
        label: "model",
        text: params.model,
      });
    }

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

    return this.runTask(
      key,
      async (client, task) => {
        const file = typeof params.image === "string" ? await fetch(params.image) : params.image;
        const mask = typeof params.mask === "string" ? await fetch(params.mask) : params.mask;

        const { data, response } = await client.images
          .edit(
            {
              image: file,
              prompt: params.prompt,
              mask: mask,
              n: params.n,
              size: params.size,
              response_format: params.response_format,
              user: params.user,
              model: params.model,
            },
            { idempotencyKey: task.idempotencyKey, ...options }
          )
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Create image edit",
        params,
        properties,
      },
      handleOpenAIError
    );
  }

  createVariation(
    key: IntegrationTaskKey,
    params: CreateImageVariationRequest,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Images.ImagesResponse> {
    let properties = [];

    if (typeof params.model === "string") {
      properties.push({
        label: "model",
        text: params.model,
      });
    }

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

    return this.runTask(
      key,
      async (client, task) => {
        const file = typeof params.image === "string" ? await fetch(params.image) : params.image;

        const { data, response } = await client.images
          .createVariation(
            {
              image: file,
              n: params.n,
              size: params.size,
              response_format: params.response_format,
              user: params.user,
              model: params.model,
            },
            { idempotencyKey: task.idempotencyKey, ...options }
          )
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Create image variation",
        params,
        properties,
      }
    );
  }
}
