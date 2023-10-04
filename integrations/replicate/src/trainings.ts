import { IntegrationTaskKey } from "@trigger.dev/sdk";
import ReplicateClient, { Page, Training } from "replicate";

import { ReplicateRunTask } from "./index";
import { CallbackTimeout, ReplicateReturnType } from "./types";
import { callbackProperties, modelProperties } from "./utils";

export class Trainings {
  constructor(private runTask: ReplicateRunTask) {}

  /** Cancel a training. */
  cancel(key: IntegrationTaskKey, params: { id: string }): ReplicateReturnType<Training> {
    return this.runTask(
      key,
      (client) => {
        return client.trainings.cancel(params.id);
      },
      {
        name: "Cancel Training",
        params,
        properties: [{ label: "Training ID", text: params.id }],
      }
    );
  }

  /** Create a new training. */
  create(
    key: IntegrationTaskKey,
    params: {
      model_owner: string;
      model_name: string;
      version_id: string;
    } & Parameters<ReplicateClient["trainings"]["create"]>[3]
  ): ReplicateReturnType<Training> {
    return this.runTask(
      key,
      (client) => {
        const { model_owner, model_name, version_id, ...options } = params;

        return client.trainings.create(model_owner, model_name, version_id, options);
      },
      {
        name: "Create Training",
        params,
        properties: modelProperties(params),
      }
    );
  }

  /** Create a new training and await the result. */
  createAndAwait(
    key: IntegrationTaskKey,
    params: {
      model_owner: string;
      model_name: string;
      version_id: string;
    } & Omit<
      Parameters<ReplicateClient["trainings"]["create"]>[3],
      "webhook" | "webhook_events_filter"
    >,
    options: CallbackTimeout = { timeoutInSeconds: 3600 }
  ): ReplicateReturnType<Training> {
    return this.runTask(
      key,
      (client, task) => {
        const { model_owner, model_name, version_id, ...options } = params;

        return client.trainings.create(model_owner, model_name, version_id, {
          ...options,
          webhook: task.callbackUrl ?? "",
          webhook_events_filter: ["completed"],
        });
      },
      {
        name: "Create And Await Training",
        params,
        properties: [...modelProperties(params), ...callbackProperties(options)],
        callback: {
          enabled: true,
          timeoutInSeconds: options.timeoutInSeconds,
        },
      }
    );
  }

  /** Fetch a training. */
  get(key: IntegrationTaskKey, params: { id: string }): ReplicateReturnType<Training> {
    return this.runTask(
      key,
      (client) => {
        return client.trainings.get(params.id);
      },
      {
        name: "Get Training",
        params,
        properties: [{ label: "Training ID", text: params.id }],
      }
    );
  }

  /** List all trainings. */
  list(key: IntegrationTaskKey): ReplicateReturnType<Page<Training>> {
    return this.runTask(
      key,
      async (client) => {
        return client.trainings.list();
      },
      {
        name: "List Trainings",
      }
    );
  }
}
