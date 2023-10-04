import { IntegrationTaskKey } from "@trigger.dev/sdk";
import ReplicateClient, { Page, Prediction } from "replicate";

import { ReplicateRunTask } from "./index";
import { CallbackTimeout, ReplicateReturnType } from "./types";
import { callbackProperties, createPredictionProperties } from "./utils";

export class Predictions {
  constructor(private runTask: ReplicateRunTask) {}

  /** Cancel a prediction. */
  cancel(key: IntegrationTaskKey, params: { id: string }): ReplicateReturnType<Prediction> {
    return this.runTask(
      key,
      (client) => {
        return client.predictions.cancel(params.id);
      },
      {
        name: "Cancel Prediction",
        params,
        properties: [{ label: "Prediction ID", text: params.id }],
      }
    );
  }

  /** Create a new prediction. */
  create(
    key: IntegrationTaskKey,
    params: Parameters<ReplicateClient["predictions"]["create"]>[0]
  ): ReplicateReturnType<Prediction> {
    return this.runTask(
      key,
      (client) => {
        return client.predictions.create(params);
      },
      {
        name: "Create Prediction",
        params,
        properties: createPredictionProperties(params),
      }
    );
  }

  /** Create a new prediction and await the result. */
  createAndAwait(
    key: IntegrationTaskKey,
    params: Omit<
      Parameters<ReplicateClient["predictions"]["create"]>[0],
      "webhook" | "webhook_events_filter"
    >,
    options: CallbackTimeout = { timeoutInSeconds: 3600 }
  ): ReplicateReturnType<Prediction> {
    return this.runTask(
      key,
      (client, task) => {
        return client.predictions.create({
          ...params,
          webhook: task.callbackUrl ?? "",
          webhook_events_filter: ["completed"],
        });
      },
      {
        name: "Create And Await Prediction",
        params,
        properties: [...createPredictionProperties(params), ...callbackProperties(options)],
        callback: {
          enabled: true,
          timeoutInSeconds: options.timeoutInSeconds,
        },
      }
    );
  }

  /** Fetch a prediction. */
  get(key: IntegrationTaskKey, params: { id: string }): ReplicateReturnType<Prediction> {
    return this.runTask(
      key,
      (client) => {
        return client.predictions.get(params.id);
      },
      {
        name: "Get Prediction",
        params,
        properties: [{ label: "Prediction ID", text: params.id }],
      }
    );
  }

  /** List all predictions. */
  list(key: IntegrationTaskKey): ReplicateReturnType<Page<Prediction>> {
    return this.runTask(
      key,
      (client) => {
        return client.predictions.list();
      },
      {
        name: "List Predictions",
      }
    );
  }
}
