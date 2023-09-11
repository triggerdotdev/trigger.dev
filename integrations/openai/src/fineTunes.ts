import { IntegrationTaskKey } from "@trigger.dev/sdk";
import OpenAI from "openai";
import { OpenAIRunTask } from "./index";

type SpecificFineTuneRequest = {
  fineTuneId: string;
};

export class FineTunes {
  runTask: OpenAIRunTask;

  constructor(runTask: OpenAIRunTask) {
    this.runTask = runTask;
  }

  create(
    key: IntegrationTaskKey,
    params: OpenAI.FineTuneCreateParams
  ): Promise<OpenAI.FineTunes.FineTune> {
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

    return this.runTask(
      key,
      async (client, task) => {
        return client.fineTunes.create(params);
      },
      {
        name: "Create fine tune",
        params,
        properties,
      }
    );
  }

  list(key: IntegrationTaskKey): Promise<OpenAI.FineTunes.FineTune[]> {
    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.fineTunes.list();
        return response.data;
      },
      {
        name: "List fine tunes",
        properties: [],
      }
    );
  }

  retrieve(
    key: IntegrationTaskKey,
    params: SpecificFineTuneRequest
  ): Promise<OpenAI.FineTunes.FineTune> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.fineTunes.retrieve(params.fineTuneId);
      },
      {
        name: "Retrieve fine tune",
        params,
        properties: [
          {
            label: "Fine tune id",
            text: params.fineTuneId,
          },
        ],
      }
    );
  }

  cancel(
    key: IntegrationTaskKey,
    params: SpecificFineTuneRequest
  ): Promise<OpenAI.FineTunes.FineTune> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.fineTunes.cancel(params.fineTuneId);
      },
      {
        name: "Cancel fine tune",
        params,
        properties: [
          {
            label: "Fine tune id",
            text: params.fineTuneId,
          },
        ],
      }
    );
  }

  listEvents(
    key: IntegrationTaskKey,
    params: SpecificFineTuneRequest
  ): Promise<OpenAI.FineTuneEventsListResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        return client.fineTunes.listEvents(params.fineTuneId, { stream: false });
      },
      {
        name: "List fine tune events",
        params,
        properties: [
          {
            label: "Fine tune id",
            text: params.fineTuneId,
          },
        ],
      }
    );
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
      params: OpenAI.FineTuning.JobCreateParams
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
          return client.fineTuning.jobs.create(params);
        },
        {
          name: "Create Fine Tuning Job",
          params,
          properties,
        }
      );
    },

    retrieve: (
      key: IntegrationTaskKey,
      params: { id: string }
    ): Promise<OpenAI.FineTuning.FineTuningJob> => {
      return this.runTask(
        key,
        async (client, task) => {
          return client.fineTuning.jobs.retrieve(params.id);
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
        }
      );
    },

    cancel: (
      key: IntegrationTaskKey,
      params: { id: string }
    ): Promise<OpenAI.FineTuning.FineTuningJob> => {
      return this.runTask(
        key,
        async (client, task) => {
          return client.fineTuning.jobs.cancel(params.id);
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
        }
      );
    },

    listEvents: (
      key: IntegrationTaskKey,
      params: { id: string }
    ): Promise<OpenAI.FineTuning.FineTuningJobEvent[]> => {
      return this.runTask(
        key,
        async (client, task) => {
          const response = await client.fineTuning.jobs.listEvents(params.id);
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
        }
      );
    },

    list: (
      key: IntegrationTaskKey,
      params: OpenAI.FineTuning.JobListParams
    ): Promise<OpenAI.FineTuning.FineTuningJob[]> => {
      return this.runTask(
        key,
        async (client, task) => {
          const response = await client.fineTuning.jobs.list(params);

          return response.data;
        },
        {
          name: "List Fine Tuning Jobs",
          params,
        }
      );
    },
  };
}
