import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { Model, ModelVersion } from "replicate";

import { ReplicateRunTask } from "./index";
import { modelProperties } from "./utils";
import { ReplicateReturnType } from "./types";

export class Models {
  constructor(private runTask: ReplicateRunTask) {}

  /** Get information about a model. */
  get(
    key: IntegrationTaskKey,
    params: {
      model_owner: string;
      model_name: string;
    }
  ): ReplicateReturnType<Model> {
    return this.runTask(
      key,
      (client) => {
        return client.models.get(params.model_owner, params.model_name);
      },
      {
        name: "Get Model",
        params,
        properties: modelProperties(params),
      }
    );
  }

  get versions() {
    return new Versions(this.runTask);
  }
}

class Versions {
  constructor(private runTask: ReplicateRunTask) {}

  /** Get a specific model version. */
  get(
    key: IntegrationTaskKey,
    params: {
      model_owner: string;
      model_name: string;
      version_id: string;
    }
  ): ReplicateReturnType<ModelVersion> {
    return this.runTask(
      key,
      (client) => {
        return client.models.versions.get(params.model_owner, params.model_name, params.version_id);
      },
      {
        name: "Get Model Version",
        params,
        properties: modelProperties(params),
      }
    );
  }

  /** List model versions. */
  list(
    key: IntegrationTaskKey,
    params: {
      model_owner: string;
      model_name: string;
    }
  ): ReplicateReturnType<ModelVersion[]> {
    return this.runTask(
      key,
      (client) => {
        return client.models.versions.list(params.model_owner, params.model_name);
      },
      {
        name: "List Models",
        params,
        properties: modelProperties(params),
      }
    );
  }
}
