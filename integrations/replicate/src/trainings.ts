import { IntegrationTaskKey } from "@trigger.dev/sdk";
import ReplicateClient, { Page, Training } from "replicate";

import { ReplicateRunTask } from "./index";
import { ReplicateReturnType } from "./types";
import { modelProperties } from "./utils";

export class Trainings {
  constructor(private runTask: ReplicateRunTask) {}

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

  createAndWaitForCompletion(
    key: IntegrationTaskKey,
    params: {
      model_owner: string;
      model_name: string;
      version_id: string;
    } & Omit<
      Parameters<ReplicateClient["trainings"]["create"]>[3],
      "webhook" | "webhook_events_filter"
    >
  ): ReplicateReturnType<Training> {
    return this.runTask(
      key,
      (client, task) => {
        const { model_owner, model_name, version_id, ...options } = params;

        return client.trainings.create(model_owner, model_name, version_id, {
          ...options,
          webhook: task.callbackUrl ?? undefined,
          webhook_events_filter: ["completed"],
        });
      },
      {
        name: "Create And Await Training",
        params,
        properties: modelProperties(params),
        callback: { enabled: true },
      }
    );
  }

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
