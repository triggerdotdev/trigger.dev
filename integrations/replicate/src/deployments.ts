import { IntegrationTaskKey } from "@trigger.dev/sdk";
import ReplicateClient, { Prediction } from "replicate";

import { ReplicateRunTask } from "./index";
import { callbackProperties, createDeploymentProperties } from "./utils";
import { CallbackTimeout, ReplicateReturnType } from "./types";

export class Deployments {
  constructor(private runTask: ReplicateRunTask) {}

  get predictions() {
    return new Predictions(this.runTask);
  }
}

class Predictions {
  constructor(private runTask: ReplicateRunTask) {}

  /** Create a new prediction with a deployment. */
  create(
    key: IntegrationTaskKey,
    params: {
      deployment_owner: string;
      deployment_name: string;
    } & Parameters<ReplicateClient["deployments"]["predictions"]["create"]>[2]
  ): ReplicateReturnType<Prediction> {
    return this.runTask(
      key,
      (client) => {
        const { deployment_owner, deployment_name, ...options } = params;

        return client.deployments.predictions.create(deployment_owner, deployment_name, options);
      },
      {
        name: "Create Prediction With Deployment",
        params,
        properties: createDeploymentProperties(params),
      }
    );
  }

  /** Create a new prediction with a deployment and await the result. */
  createAndAwait(
    key: IntegrationTaskKey,
    params: {
      deployment_owner: string;
      deployment_name: string;
    } & Omit<
      Parameters<ReplicateClient["deployments"]["predictions"]["create"]>[2],
      "webhook" | "webhook_events_filter"
    >,
    options: CallbackTimeout = { timeoutInSeconds: 3600 }
  ): ReplicateReturnType<Prediction> {
    return this.runTask(
      key,
      (client, task) => {
        const { deployment_owner, deployment_name, ...options } = params;

        return client.deployments.predictions.create(deployment_owner, deployment_name, {
          ...options,
          webhook: task.callbackUrl ?? "",
          webhook_events_filter: ["completed"],
        });
      },
      {
        name: "Create And Await Prediction With Deployment",
        params,
        properties: [...createDeploymentProperties(params), ...callbackProperties(options)],
        callback: {
          enabled: true,
          timeoutInSeconds: options.timeoutInSeconds,
        },
      }
    );
  }
}
