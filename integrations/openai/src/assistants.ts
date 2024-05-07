import { IntegrationTaskKey, Prettify } from "@trigger.dev/sdk";
import { OpenAIRunTask } from "./index";
import { OpenAIIntegrationOptions, OpenAIRequestOptions } from "./types";
import OpenAI from "openai";
import { createTaskOutputProperties, handleOpenAIError, isRequestOptions } from "./taskUtils";

export class Assistants {
  constructor(
    private runTask: OpenAIRunTask,
    private options: OpenAIIntegrationOptions
  ) { }

  async create(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.Beta.AssistantCreateParams>,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Assistant> {
    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.beta.assistants
          .create(params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        const outputProperties = createTaskOutputProperties(undefined, response.headers);

        task.outputProperties = [
          ...(outputProperties ?? []),
          {
            label: "assistantId",
            text: data.id,
          },
        ];

        return data;
      },
      {
        name: "Create Assistant",
        params,
        properties: [
          {
            label: "model",
            text: params.model,
          },
          ...(params.name ? [{ label: "name", text: params.name }] : []),
          ...(params.file_ids && params.file_ids.length > 0
            ? [{ label: "files", text: params.file_ids.join(", ") }]
            : []),
        ],
      },
      handleOpenAIError
    );
  }

  async update(
    key: IntegrationTaskKey,
    id: string,
    params: Prettify<OpenAI.Beta.AssistantUpdateParams>,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Assistant> {
    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.beta.assistants
          .update(id, params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        const outputProperties = createTaskOutputProperties(undefined, response.headers);

        task.outputProperties = [
          ...(outputProperties ?? []),
          {
            label: "assistantId",
            text: data.id,
          },
        ];

        return data;
      },
      {
        name: "Update Assistant",
        params,
        properties: [
          ...(params.model ? [{ label: "model", text: params.model }] : []),
          ...(params.name ? [{ label: "name", text: params.name }] : []),
          ...(params.file_ids && params.file_ids.length > 0
            ? [{ label: "files", text: params.file_ids.join(", ") }]
            : []),
        ],
      },
      handleOpenAIError
    );
  }

  list(
    key: IntegrationTaskKey,
    params?: Prettify<OpenAI.Beta.AssistantListParams>,
    options?: OpenAIRequestOptions,
  ): Promise<OpenAI.Beta.Assistant[]>;
  list(
    key: IntegrationTaskKey,
    options?: OpenAIRequestOptions,
  ): Promise<OpenAI.Beta.Assistant[]>;
  async list(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.Beta.AssistantListParams> | OpenAIRequestOptions = {},
    options: OpenAIRequestOptions | undefined = undefined
  ): Promise<OpenAI.Beta.Assistant[]> {
    return this.runTask(
      key,
      async (client, task) => {
        if (isRequestOptions(params)) {
          const { data, response } = await client.beta.assistants
            .list({
              idempotencyKey: task.idempotencyKey,
              ...params,
            })
            .withResponse();

          task.outputProperties = createTaskOutputProperties(undefined, response.headers);

          return data.data;
        }

        const { data, response } = await client.beta.assistants
          .list(params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data.data;

      },
      {
        name: "List Assistants",
        params,
        properties: !isRequestOptions(params) ? [
          ...(params.before ? [{ label: "before", text: params.before }] : []),
          ...(params.order ? [{ label: "order", text: params.order }] : []),
          ...(params.after ? [{ label: "after", text: params.after }] : []),
          ...(params.limit ? [{ label: "limit", text: String(params.limit) }] : []),
        ] : [],
      },
      handleOpenAIError
    );
  }

  async del(
    key: IntegrationTaskKey,
    id: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.AssistantDeleted> {
    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.beta.assistants
          .del(id, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Delete Assistant",
        params: {
          id,
        },
        properties: [
          {
            label: "assistantId",
            text: id,
          },
        ],
      },
      handleOpenAIError
    );
  }

  async retrieve(
    key: IntegrationTaskKey,
    id: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Assistant> {
    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.beta.assistants
          .retrieve(id, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Retrieve Assistant",
        params: {
          id,
        },
        properties: [
          {
            label: "assistantId",
            text: id,
          },
        ],
      },
      handleOpenAIError
    );
  }
}
