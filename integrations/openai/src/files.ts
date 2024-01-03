import { Buffer } from "node:buffer";
import { IntegrationTaskKey } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import { OpenAIIntegrationOptions, OpenAIRequestOptions } from "./types";
import {
  createBackgroundFetchHeaders,
  createBackgroundFetchUrl,
  createTaskOutputProperties,
  handleOpenAIError,
} from "./taskUtils";
import { Uploadable, toFile } from "openai/uploads";

type CreateFileRequest = {
  file: string | File | Uploadable;
  fileName?: string;
  purpose: "fine-tune" | "assistants";
};

type CreateFineTuneFileRequest = {
  fileName: string;
  examples: {
    prompt: string;
    completion: string;
  }[];
};

export class Files {
  constructor(
    private runTask: OpenAIRunTask,
    private options: OpenAIIntegrationOptions
  ) {}

  create(
    key: IntegrationTaskKey,
    params: CreateFileRequest,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Files.FileObject> {
    return this.runTask(
      key,
      async (client, task) => {
        let file: Uploadable;

        if (typeof params.file === "string") {
          file = await toFile(Buffer.from(params.file), params.fileName ?? "file.txt");
        } else {
          file = params.file;
        }

        return client.files.create(
          { file, purpose: params.purpose },
          { idempotencyKey: task.idempotencyKey, ...options }
        );
      },
      {
        name: "Create file",
        params,
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
      },
      handleOpenAIError
    );
  }

  async createAndWaitForProcessing(
    key: IntegrationTaskKey,
    params: CreateFileRequest,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Files.FileObject> {
    return this.runTask(
      key,
      async (client, task, io) => {
        let file: Uploadable;

        if (typeof params.file === "string") {
          file = await toFile(Buffer.from(params.file), params.fileName ?? "file.txt");
        } else {
          file = params.file;
        }

        const { data, response } = await client.files
          .create(
            { file, purpose: params.purpose },
            { idempotencyKey: task.idempotencyKey, ...options }
          )
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        if (["processed", "error", "deleted"].includes(data.status)) {
          return data;
        }

        const url = createBackgroundFetchUrl(
          client,
          `/files/${data.id}`,
          this.options.defaultQuery,
          options
        );

        const headers = this.options.defaultHeaders ?? {};

        const processedFile = await io.backgroundPoll<OpenAI.Files.FileObject>("poll", {
          url,
          requestInit: {
            headers: createBackgroundFetchHeaders(client, task.idempotencyKey, headers, options),
          },
          interval: 10,
          timeout: 600,
          responseFilter: {
            status: [200],
            body: {
              status: ["processed", "error", "deleted"],
            },
          },
        });

        return processedFile;
      },
      {
        name: "Create file and wait for processing",
        params,
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
      },
      handleOpenAIError
    );
  }

  async waitForProcessing(
    key: IntegrationTaskKey,
    id: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Files.FileObject> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const url = createBackgroundFetchUrl(
          client,
          `/files/${id}`,
          this.options.defaultQuery,
          options
        );

        const headers = this.options.defaultHeaders ?? {};

        const processedFile = await io.backgroundPoll<OpenAI.Files.FileObject>("poll", {
          url,
          requestInit: {
            headers: createBackgroundFetchHeaders(client, task.idempotencyKey, headers, options),
          },
          interval: 10,
          timeout: 600,
          responseFilter: {
            status: [200],
            body: {
              status: ["processed", "error", "deleted"],
            },
          },
        });

        return processedFile;
      },
      {
        name: "Wait for processing",
        properties: [
          {
            label: "fileId",
            text: id,
          },
        ],
      },
      handleOpenAIError
    );
  }

  retrieve(
    key: IntegrationTaskKey,
    id: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Files.FileObject> {
    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.files.retrieve(id, options);
        return response;
      },
      {
        name: "Retrieve file",
        properties: [
          {
            label: "fileId",
            text: id,
          },
        ],
      },
      handleOpenAIError
    );
  }

  list(
    key: IntegrationTaskKey,
    query?: OpenAI.Files.FileListParams,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Files.FileObject[]> {
    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.files.list(query, options);

        return response.data;
      },
      {
        name: "List files",
        properties: [],
      },
      handleOpenAIError
    );
  }

  createFineTune(
    key: IntegrationTaskKey,
    params: CreateFineTuneFileRequest,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Files.FileObject> {
    return this.runTask(
      key,
      async (client, task) => {
        const file = await toFile(
          Buffer.from(params.examples.map((d) => JSON.stringify(d)).join("\n")),
          params.fileName
        );

        return client.files.create(
          { file, purpose: "fine-tune" },
          { idempotencyKey: task.idempotencyKey, ...options }
        );
      },
      {
        name: "Create fine tune file",
        params,
        properties: [
          {
            label: "Examples",
            text: params.examples.length.toString(),
          },
        ],
      },
      handleOpenAIError
    );
  }
}
