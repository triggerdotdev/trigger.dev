import { IntegrationTaskKey } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";
import { OpenAIRequestOptions } from "./types";
import { handleOpenAIError } from "./taskUtils";

export class FineTuning {
  runTask: OpenAIRunTask;

  constructor(runTask: OpenAIRunTask) {
    this.runTask = runTask;
  }

  jobs = {
    /**
     * Creates a job that fine-tunes a specified model from a given dataset.
     *
     * Response includes details of the enqueued job including job status and the name
     * of the fine-tuned models once complete.
     *
     * [Learn more about fine-tuning](https://platform.openai.com/docs/guides/fine-tuning)
     */
    create: (
      key: IntegrationTaskKey,
      params: OpenAI.FineTuning.JobCreateParams,
      options: OpenAIRequestOptions = {}
    ): Promise<OpenAI.FineTuning.FineTuningJob> => {
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

      return this.runTask(
        key,
        async (client, task) => {
          return client.fineTuning.jobs.create(params, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          });
        },
        {
          name: "Create Fine Tuning Job",
          params,
          properties,
        },
        handleOpenAIError
      );
    },

    retrieve: (
      key: IntegrationTaskKey,
      params: { id: string },
      options: OpenAIRequestOptions = {}
    ): Promise<OpenAI.FineTuning.FineTuningJob> => {
      return this.runTask(
        key,
        async (client, task) => {
          return client.fineTuning.jobs.retrieve(params.id, options);
        },
        {
          name: "Retrieve Fine Tuning Job",
          params,
          properties: [
            {
              label: "Job ID",
              text: params.id,
            },
          ],
        },
        handleOpenAIError
      );
    },

    cancel: (
      key: IntegrationTaskKey,
      params: { id: string },
      options: OpenAIRequestOptions = {}
    ): Promise<OpenAI.FineTuning.FineTuningJob> => {
      return this.runTask(
        key,
        async (client, task) => {
          return client.fineTuning.jobs.cancel(params.id, {
            idempotencyKey: task.idempotencyKey,
            ...options,
          });
        },
        {
          name: "Cancel Fine Tuning Job",
          params,
          properties: [
            {
              label: "Job ID",
              text: params.id,
            },
          ],
        },
        handleOpenAIError
      );
    },

    listEvents: (
      key: IntegrationTaskKey,
      params: { id: string },
      options: OpenAIRequestOptions = {}
    ): Promise<OpenAI.FineTuning.FineTuningJobEvent[]> => {
      return this.runTask(
        key,
        async (client, task) => {
          const response = await client.fineTuning.jobs.listEvents(params.id, options);
          return response.data;
        },
        {
          name: "List Fine Tuning Job Events",
          params,
          properties: [
            {
              label: "Job ID",
              text: params.id,
            },
          ],
        },
        handleOpenAIError
      );
    },

    list: (
      key: IntegrationTaskKey,
      params: OpenAI.FineTuning.JobListParams,
      options: OpenAIRequestOptions = {}
    ): Promise<OpenAI.FineTuning.FineTuningJob[]> => {
      return this.runTask(
        key,
        async (client, task) => {
          const response = await client.fineTuning.jobs.list(params, options);

          return response.data;
        },
        {
          name: "List Fine Tuning Jobs",
          params,
        },
        handleOpenAIError
      );
    },
  };
}
