import { IntegrationTaskKey, Prettify } from "@trigger.dev/sdk";
import { OpenAIRunTask } from "./index";
import { OpenAIIntegrationOptions, OpenAIRequestOptions } from "./types";
import OpenAI from "openai";
import {
  createBackgroundFetchHeaders,
  createBackgroundFetchUrl,
  createTaskOutputProperties,
  handleOpenAIError,
  isRequestOptions,
} from "./taskUtils";
import { RunSubmitToolOutputsParams } from "openai/resources/beta/threads/runs/runs";
import { ThreadUpdateParams } from "openai/resources/beta/threads/threads";

export class Threads {
  constructor(
    private runTask: OpenAIRunTask,
    private options: OpenAIIntegrationOptions
  ) {}

  /**
   * Create a thread and run it in one task.
   */
  async createAndRun(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.Beta.ThreadCreateAndRunParams>,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.Run> {
    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.beta.threads
          .createAndRun(params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        const outputProperties = [
          ...(createTaskOutputProperties(undefined, response.headers) ?? []),
          {
            label: "threadId",
            text: data.thread_id,
          },
          {
            label: "runId",
            text: data.id,
          },
        ];

        task.outputProperties = outputProperties;

        return data;
      },
      {
        name: "Create Thread and Run",
        params,
      },
      handleOpenAIError
    );
  }

  /**
   * Create a thread and runs it in one task, and only returns when the run is completed by polling in the background.
   */
  async createAndRunUntilCompletion(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.Beta.ThreadCreateAndRunParams>,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.Run> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const { data, response } = await client.beta.threads
          .createAndRun(params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        const outputProperties = [
          ...(createTaskOutputProperties(undefined, response.headers) ?? []),
          {
            label: "threadId",
            text: data.thread_id,
          },
          {
            label: "runId",
            text: data.id,
          },
        ];

        task.outputProperties = outputProperties;

        const url = createBackgroundFetchUrl(
          client,
          `/threads/${data.thread_id}/runs/${data.id}`,
          this.options.defaultQuery,
          options
        );

        const headers = this.options.defaultHeaders ?? {};

        headers["OpenAI-Beta"] = "assistants=v1";

        const completedRun = await io.backgroundPoll<OpenAI.Beta.Threads.Run>("poll", {
          url,
          requestInit: {
            headers: createBackgroundFetchHeaders(client, task.idempotencyKey, headers, options),
          },
          interval: 10,
          timeout: 600,
          responseFilter: {
            status: [200],
            body: {
              status: ["completed", "expired", "cancelled", "failed", "requires_action"],
            },
          },
        });

        return completedRun;
      },
      {
        name: "Run Created Thread and Wait for Completion",
        params,
      },
      handleOpenAIError
    );
  }

  /**
   * Create a thread.
   */
  async create(
    key: IntegrationTaskKey,
    params: Prettify<OpenAI.Beta.ThreadCreateParams> = {},
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Thread> {
    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.beta.threads
          .create(params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Create Thread",
        params,
      },
      handleOpenAIError
    );
  }

  /**
   * Retrieves a thread.
   */
  async retrieve(
    key: IntegrationTaskKey,
    threadId: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Thread> {
    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.beta.threads
          .retrieve(threadId, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Retrieve Thread",
        properties: [{ label: "threadId", text: threadId }],
      },
      handleOpenAIError
    );
  }

  /**
   * Modifies a thread.
   */
  async update(
    key: IntegrationTaskKey,
    threadId: string,
    body: ThreadUpdateParams,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Thread> {
    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.beta.threads
          .update(threadId, body, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Update Thread",
        properties: [{ label: "threadId", text: threadId }],
      },
      handleOpenAIError
    );
  }

  /**
   * Delete a thread.
   */
  async del(
    key: IntegrationTaskKey,
    threadId: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.ThreadDeleted> {
    return this.runTask(
      key,
      async (client, task) => {
        const { data, response } = await client.beta.threads
          .del(threadId, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Delete Thread",
        properties: [{ label: "threadId", text: threadId }],
      },
      handleOpenAIError
    );
  }

  get runs() {
    return new Runs(this.runTask.bind(this), this.options);
  }

  get messages() {
    return new Messages(this.runTask.bind(this), this.options);
  }
}

class Runs {
  constructor(
    private runTask: OpenAIRunTask,
    private options: OpenAIIntegrationOptions
  ) {}

  /**
   * Creates a run and waits for it to complete by polling in the background.
   */
  async createAndWaitForCompletion(
    key: IntegrationTaskKey,
    threadId: string,
    params: Prettify<OpenAI.Beta.Threads.RunCreateParams>,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.Run> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const { data, response } = await client.beta.threads.runs
          .create(threadId, params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        const url = createBackgroundFetchUrl(
          client,
          `/threads/${threadId}/runs/${data.id}`,
          this.options.defaultQuery,
          options
        );

        const headers = this.options.defaultHeaders ?? {};

        headers["OpenAI-Beta"] = "assistants=v1";

        const completedRun = await io.backgroundPoll<OpenAI.Beta.Threads.Run>("poll", {
          url,
          requestInit: {
            headers: createBackgroundFetchHeaders(client, task.idempotencyKey, headers, options),
          },
          interval: 10,
          timeout: 600,
          responseFilter: {
            status: [200],
            body: {
              status: ["completed", "expired", "cancelled", "failed", "requires_action"],
            },
          },
        });

        return completedRun;
      },
      {
        name: "Run Thread and Wait for Completion",
        params,
        properties: [{ label: "threadId", text: threadId }],
      },
      handleOpenAIError
    );
  }

  /**
   * Waits for a run to complete by polling in the background.
   */
  async waitForCompletion(
    key: IntegrationTaskKey,
    threadId: string,
    runId: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.Run> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const url = createBackgroundFetchUrl(
          client,
          `/threads/${threadId}/runs/${runId}`,
          this.options.defaultQuery,
          options
        );

        const headers = this.options.defaultHeaders ?? {};

        headers["OpenAI-Beta"] = "assistants=v1";

        const completedRun = await io.backgroundPoll<OpenAI.Beta.Threads.Run>("poll", {
          url,
          requestInit: {
            headers: createBackgroundFetchHeaders(client, task.idempotencyKey, headers, options),
          },
          interval: 10,
          timeout: 600,
          responseFilter: {
            status: [200],
            body: {
              status: ["completed", "expired", "cancelled", "failed", "requires_action"],
            },
          },
        });

        return completedRun;
      },
      {
        name: "Wait for Run Completion",
        properties: [
          { label: "threadId", text: threadId },
          { label: "runId", text: runId },
        ],
      },
      handleOpenAIError
    );
  }

  /**
   * Creates a run.
   */
  async create(
    key: IntegrationTaskKey,
    threadId: string,
    params: Prettify<OpenAI.Beta.Threads.RunCreateParams>,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.Run> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const { data, response } = await client.beta.threads.runs
          .create(threadId, params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Run Thread",
        params,
        properties: [{ label: "threadId", text: threadId }],
      },
      handleOpenAIError
    );
  }

  /**
   * Retrieves a run.
   */
  async retrieve(
    key: IntegrationTaskKey,
    threadId: string,
    runId: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.Run> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const { data, response } = await client.beta.threads.runs
          .retrieve(threadId, runId, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Retrieve Run",
        properties: [
          { label: "threadId", text: threadId },
          { label: "runId", text: runId },
        ],
      },
      handleOpenAIError
    );
  }

  /**
   * Cancels a run that is `in_progress`.
   */
  async cancel(
    key: IntegrationTaskKey,
    threadId: string,
    runId: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.Run> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const { data, response } = await client.beta.threads.runs
          .cancel(threadId, runId, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Cancel Run",
        properties: [
          { label: "threadId", text: threadId },
          { label: "runId", text: runId },
        ],
      },
      handleOpenAIError
    );
  }

  /**
   * When a run has the `status: "requires_action"` and `required_action.type` is
   * `submit_tool_outputs`, this endpoint can be used to submit the outputs from the
   * tool calls once they're all completed. All outputs must be submitted in a single
   * request.
   */
  async submitToolOutputs(
    key: IntegrationTaskKey,
    threadId: string,
    runId: string,
    body: RunSubmitToolOutputsParams,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.Run> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const { data, response } = await client.beta.threads.runs
          .submitToolOutputs(threadId, runId, body, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Submit Tool Outputs",
        properties: [
          { label: "threadId", text: threadId },
          { label: "runId", text: runId },
        ],
      },
      handleOpenAIError
    );
  }

  /**
   * Returns all runs belonging to a thread.
   */
  async list(
    key: IntegrationTaskKey,
    threadId: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.Run[]> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const { data: page, response } = await client.beta.threads.runs
          .list(threadId, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        const allRuns = [];

        for await (const fineTuningJob of page) {
          allRuns.push(fineTuningJob);
        }

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return allRuns;
      },
      {
        name: "List Runs",
        properties: [{ label: "threadId", text: threadId }],
      },
      handleOpenAIError
    );
  }
}

class Messages {
  constructor(
    private runTask: OpenAIRunTask,
    private options: OpenAIIntegrationOptions
  ) {}

  /**
   * Returns messages for a given thread.
   */
  list(
    key: IntegrationTaskKey,
    threadId: string,
    params?: Prettify<OpenAI.Beta.Threads.MessageListParams>,
    options?: OpenAIRequestOptions
  ): Promise<OpenAI.Beta.Threads.ThreadMessage[]>;
  list(
    key: IntegrationTaskKey,
    threadId: string,
    options?: OpenAIRequestOptions
  ): Promise<OpenAI.Beta.Threads.ThreadMessage[]>;
  async list(
    key: IntegrationTaskKey,
    threadId: string,
    params: Prettify<OpenAI.Beta.AssistantListParams> | OpenAIRequestOptions = {},
    options: OpenAIRequestOptions | undefined = undefined
  ): Promise<OpenAI.Beta.Threads.ThreadMessage[]> {
    return this.runTask(
      key,
      async (client, task, io) => {
        if (isRequestOptions(params)) {
          const { data: page, response } = await client.beta.threads.messages
            .list(threadId, {
              idempotencyKey: task.idempotencyKey,
              ...params,
            })
            .withResponse();

          task.outputProperties = createTaskOutputProperties(undefined, response.headers);

          return page.data;
        }

        const { data: page, response } = await client.beta.threads.messages
          .list(threadId, params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return page.data;
      },
      {
        name: "List Messages",
        properties: [{ label: "threadId", text: threadId }],
      },
      handleOpenAIError
    );
  }

  /**
   * Returns all messages for a given thread.
   */
  async listAll(
    key: IntegrationTaskKey,
    threadId: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.ThreadMessage[]> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const { data: page, response } = await client.beta.threads.messages
          .list(threadId, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        const allMessages = [];

        for await (const message of page) {
          allMessages.push(message);
        }

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return allMessages;
      },
      {
        name: "List All Messages",
        properties: [{ label: "threadId", text: threadId }],
      },
      handleOpenAIError
    );
  }

  /**
   * Create a message.
   */
  async create(
    key: IntegrationTaskKey,
    threadId: string,
    body: Prettify<OpenAI.Beta.Threads.MessageCreateParams>,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.ThreadMessage> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const { data, response } = await client.beta.threads.messages
          .create(threadId, body, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Create Message",
        properties: [{ label: "threadId", text: threadId }],
      },
      handleOpenAIError
    );
  }

  /**
   * Retrieve a message.
   */
  async retrieve(
    key: IntegrationTaskKey,
    threadId: string,
    messageId: string,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.ThreadMessage> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const { data, response } = await client.beta.threads.messages
          .retrieve(threadId, messageId, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Retrieve Message",
        properties: [
          { label: "threadId", text: threadId },
          { label: "messageId", text: messageId },
        ],
      },
      handleOpenAIError
    );
  }

  /**
   * Modifies a message.
   */
  async update(
    key: IntegrationTaskKey,
    threadId: string,
    messageId: string,
    body: Prettify<OpenAI.Beta.Threads.MessageUpdateParams>,
    options: OpenAIRequestOptions = {}
  ): Promise<OpenAI.Beta.Threads.ThreadMessage> {
    return this.runTask(
      key,
      async (client, task, io) => {
        const { data, response } = await client.beta.threads.messages
          .update(threadId, messageId, body, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          })
          .withResponse();

        task.outputProperties = createTaskOutputProperties(undefined, response.headers);

        return data;
      },
      {
        name: "Update Message",
        properties: [
          { label: "threadId", text: threadId },
          { label: "messageId", text: messageId },
        ],
      },
      handleOpenAIError
    );
  }
}
