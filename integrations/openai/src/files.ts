import { fileFromString } from "@trigger.dev/integration-kit";
import { IntegrationTaskKey } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import { OpenAIRequestOptions } from "./types";

type CreateFileRequest = {
  file: string | File;
  fileName?: string;
  purpose: string;
};

type CreateFineTuneFileRequest = {
  fileName: string;
  examples: {
    prompt: string;
    completion: string;
  }[];
};

export class Files {
  runTask: OpenAIRunTask;

  constructor(runTask: OpenAIRunTask) {
    this.runTask = runTask;
  }

  create(
    key: IntegrationTaskKey,
    params: CreateFileRequest,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Files.FileObject> {
    return this.runTask(
      key,
      async (client, task) => {
        let file: File;

        if (typeof params.file === "string") {
          file = await fileFromString(params.file, params.fileName ?? "file.txt");
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
      }
    );
  }

  list(
    key: IntegrationTaskKey,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Files.FileObject[]> {
    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.files.list(options);
        return response.data;
      },
      {
        name: "List files",
        properties: [],
      }
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
        const file = await fileFromString(
          params.examples.map((d) => JSON.stringify(d)).join("\n"),
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
      }
    );
  }
}
