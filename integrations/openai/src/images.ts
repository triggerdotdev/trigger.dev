import { fileFromUrl, truncate } from "@trigger.dev/integration-kit";
import { IntegrationTaskKey, Prettify } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import { createTaskUsageProperties } from "./taskUtils";

export type CreateImageEditRequest = {
  image: string | File;
  prompt: string;
  mask?: string | File;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024";
  response_format?: "url" | "b64_json";
  user?: string;
};

export type CreateImageVariationRequest = {
  image: string | File;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024";
  response_format?: "url" | "b64_json";
  user?: string;
};

export class Images {
  runTask: OpenAIRunTask;

  constructor(runTask: OpenAIRunTask) {
    this.runTask = runTask;
  }

  generate(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.Images.ImageGenerateParams>
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
        return client.images.generate(params);
      },
      {
        name: "Create image",
        params,
        properties,
      }
    );
  }

  edit(
    key: IntegrationTaskKey,
    params: CreateImageEditRequest
  ): Promise<OpenAI.Images.ImagesResponse> {
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

    return this.runTask(
      key,
      async (client, task) => {
        const file =
          typeof params.image === "string" ? await fileFromUrl(params.image) : params.image;
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
      {
        name: "Create image edit",
        params,
        properties,
      }
    );
  }

  createVariation(
    key: IntegrationTaskKey,
    params: CreateImageVariationRequest
  ): Promise<OpenAI.Images.ImagesResponse> {
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

    return this.runTask(
      key,
      async (client, task) => {
        const file =
          typeof params.image === "string" ? await fileFromUrl(params.image) : params.image;

        const response = await client.images.createVariation({
          image: file,
          n: params.n,
          size: params.size,
          response_format: params.response_format,
          user: params.user,
        });

        return response;
      },
      {
        name: "Create image variation",
        params,
        properties,
      }
    );
  }
}
